import webview
import os
import json
import time
import threading
import uuid
import multiprocessing
import polars as pl

from lwc.drawings import DrawingTool
from lwc.time_utils import DateTimeEncoder, process_polars_data, ensure_timestamp, timestamp_to_date_str

#########################################################################################################

class Series:
    """
    Represents a specific data series on the chart (e.g., price line, indicator).
    """
    def __init__(self, chart, series_id, name, chart_id='chart-0'):
        """
        Initialize the Series.
        
        Args:
           chart (Chart): The parent Chart instance.
           series_id (str): Unique identifier for the series.
           name (str): Display name of the series.
           chart_id (str): The ID of the chart this series belongs to.
        """
        self.chart = chart
        self.series_id = series_id
        self.name = name
        self.chart_id = chart_id

    def set_data(self, data, fit=False):
        """
        Set the entire dataset for this series.
        
        Args:
            data (pl.DataFrame): The data points to set.
            fit (bool): If True, automatically fits the chart content.
        """
        if not isinstance(data, pl.DataFrame):
            raise TypeError("Data must be a Polars DataFrame")
        
        # Auto-convert dates
        data = self.chart._process_polars_data(data)
        
        # Handle Volume
        vol_col = next((c for c in data.columns if c.lower() == 'volume'), None)
        if vol_col:
            open_col = next((c for c in data.columns if c.lower() == 'open'), None)
            close_col = next((c for c in data.columns if c.lower() == 'close'), None)
            
            vol_series_name = f"Volume_{self.chart_id}"
            existing_vol = [s for s in self.chart.series.values() if s.name == vol_series_name and getattr(s, 'chart_id', None) == self.chart_id]
            
            if not existing_vol:
                vol_series = self.chart.create_histogram_series(
                    name=vol_series_name, 
                    price_scale_id='volume_scale',
                    chart_id=self.chart_id
                )
                self.chart.configure_price_scale(
                    scale_id='volume_scale', 
                    auto_scale=True, 
                    scale_margin_top=0.8, 
                    scale_margin_bottom=0, 
                    chart_id=self.chart_id
                )
            else:
                vol_series = existing_vol[0]

            if open_col and close_col:
                vol_color = pl.when(pl.col(close_col) >= pl.col(open_col)).then(pl.lit('rgba(38, 166, 154, 0.5)')).otherwise(pl.lit('rgba(239, 83, 80, 0.5)'))
                vol_data = data.select([
                    pl.col('time'),
                    pl.col(vol_col).alias('value'),
                    vol_color.alias('color')
                ])
            else:
                vol_data = data.select([
                    pl.col('time'),
                    pl.col(vol_col).alias('value'),
                    pl.lit('rgba(38, 166, 154, 0.5)').alias('color')
                ])
                
            vol_dicts = vol_data.drop_nulls().to_dicts()
            self.chart._send_series_data(vol_series.series_id, vol_dicts)
        
        data_dicts = data.drop_nulls().to_dicts()
        self.chart._send_series_data(self.series_id, data_dicts)

    def update(self, item):
        """
        Update the series with a new single data point.
        
        Args:
            item (pl.DataFrame): The new data point.
        """
        if not isinstance(item, pl.DataFrame):
            raise TypeError("Item must be a Polars DataFrame")
        
        # Auto-convert dates
        item = self.chart._process_polars_data(item)
        
        # Handle Volume
        vol_col = next((c for c in item.columns if c.lower() == 'volume'), None)
        if vol_col:
            open_col = next((c for c in item.columns if c.lower() == 'open'), None)
            close_col = next((c for c in item.columns if c.lower() == 'close'), None)
            
            vol_series_name = f"Volume_{self.chart_id}"
            existing_vol = [s for s in self.chart.series.values() if s.name == vol_series_name and getattr(s, 'chart_id', None) == self.chart_id]
            
            if existing_vol:
                vol_series = existing_vol[0]
                
                if open_col and close_col:
                    vol_color = pl.when(pl.col(close_col) >= pl.col(open_col)).then(pl.lit('rgba(38, 166, 154, 0.5)')).otherwise(pl.lit('rgba(239, 83, 80, 0.5)'))
                    vol_data = item.select([
                        pl.col('time'),
                        pl.col(vol_col).alias('value'),
                        vol_color.alias('color')
                    ])
                else:
                    vol_data = item.select([
                        pl.col('time'),
                        pl.col(vol_col).alias('value'),
                        pl.lit('rgba(38, 166, 154, 0.5)').alias('color')
                    ])
                    
                vol_item_dict = vol_data.to_dicts()[0]
                self.chart._send_series_update(vol_series.series_id, vol_item_dict)
        
        # Taking the first row as the item
        # drop_nulls before converting to dict to ensure we don't send malformed points
        item_clean = item.drop_nulls()
        if not item_clean.is_empty():
            item_dict = item_clean.to_dicts()[0]
            self.chart._send_series_update(self.series_id, item_dict)
#########################################################################################################


class JSApi:
    def __init__(self):
        self.ready_event = threading.Event()

    def mark_ready(self):
        print("GUI Process: Frontend signaled ready", flush=True)
        self.ready_event.set()

def _gui_process(html_path, queue, width=1000, height=800):
    """
    Function to run in the separate GUI process.
    It creates the window and polls the queue for commands.
    """
    api = JSApi()
    window = webview.create_window('Lightweight Charts', f'file://{html_path}', width=width, height=height, js_api=api)
    
    # Shared flag to control the loop
    keep_running = True

    def on_closed():
        nonlocal keep_running
        keep_running = False
        print("GUI Process: Window closed", flush=True)

    window.events.closed += on_closed
    
    def process_queue():
        print("GUI Process: Queue processor started", flush=True)
        
        # Wait for frontend to signal ready
        # We give it generous time, but it should be instant.
        if not api.ready_event.wait(timeout=10.0):
             print("GUI Process: Warning - Frontend did not signal ready, proceeding anyway...", flush=True)
        else:
             print("GUI Process: Frontend ready (Event)", flush=True)
        
        while keep_running:
            try:
                # Blocking check with timeout to allow checking keep_running
                try:
                    cmd = queue.get(timeout=0.1)
                except:
                    # Timeout, loop again to check keep_running
                    continue

                if cmd is None: # Poison pill
                    print("GUI Process: Received exit signal", flush=True)
                    window.destroy()
                    break
                
                # Batching: Collect more commands if available to reduce JS round-trips
                commands = [cmd]
                try:
                    # Limit batch size to prevent UI freeze and ensure responsiveness
                    while len(commands) < 50:
                        try:
                            # Non-blocking fetch
                            next_cmd = queue.get_nowait()
                            if next_cmd is None:
                                # Put back the poison pill for the next iteration to handle
                                queue.put(None)
                                break
                            commands.append(next_cmd)
                        except:
                            # Queue empty
                            break
                except Exception as e:
                    pass

                # Execute JS batch
                # We simply iterate and call handleCommand for each
                # Use a JS IIFE to handle the array
                cmds_json = json.dumps(commands, cls=DateTimeEncoder)
                js_code = f"""
                (function(cmds) {{
                    if (window.handleCommand) {{
                        cmds.forEach(cmd => window.handleCommand(cmd));
                    }}
                }})({cmds_json})
                """
                window.evaluate_js(js_code)
            except Exception as e:
                # If window is destroyed, evaluate_js might fail
                if not keep_running: 
                    break
                print(f"GUI Error: {e}")
                
    webview.start(process_queue, debug=False)
#########################################################################################################

class SubChart:
    """
    A proxy class representing a specific sub-chart (chart pane).
    Simplifies API calls by automatically passing the correct chart_id.
    """
    def __init__(self, chart, chart_id):
        self._chart = chart
        self.chart_id = chart_id
        
        # Proxy for toolbox that injects chart_id
        self.toolbox = self._ToolboxProxy(chart.toolbox, chart_id)

    def create_line_series(self, name, **kwargs):
        """Wrapper for create_line_series forcing chart_id."""
        kwargs['chart_id'] = self.chart_id
        return self._chart.create_line_series(name, **kwargs)

    def create_histogram_series(self, name, **kwargs):
        """Wrapper for create_histogram_series forcing chart_id."""
        kwargs['chart_id'] = self.chart_id
        return self._chart.create_histogram_series(name, **kwargs)

    def create_candlestick_series(self, name, **kwargs):
        """Wrapper for create_candlestick_series forcing chart_id."""
        kwargs['chart_id'] = self.chart_id
        return self._chart.create_candlestick_series(name, **kwargs)

    def set_watermark(self, text, **kwargs):
        """Wrapper for set_watermark forcing chart_id."""
        kwargs['chart_id'] = self.chart_id
        self._chart.set_watermark(text, **kwargs)

    def create_pane(self, name, **kwargs):
        """Create an indicator pane within this chart. Wrapper for create_sub_chart forcing chart_id."""
        kwargs['chart_id'] = self.chart_id
        return self._chart.create_sub_chart(name, **kwargs)

    
    class _ToolboxProxy:
        """Helper to intercept toolbox calls and inject chart_id."""
        def __init__(self, toolbox, chart_id):
            self._toolbox = toolbox
            self._chart_id = chart_id
            
        def __getattr__(self, name):
            attr = getattr(self._toolbox, name)
            if callable(attr):
                def wrapper(*args, **kwargs):
                    if 'chart_id' not in kwargs:
                        kwargs['chart_id'] = self._chart_id
                    return attr(*args, **kwargs)
                return wrapper
            return attr
#########################################################################################################

class Chart:
    """
    Main controller class for the backend chart logic.
    Handles process communication, command sending, and managing chart resources.
    """
    def __init__(self):
        """
        Initialize the Chart controller, including the multiprocessing queue and GUI process setup.
        """
        self.queue = multiprocessing.Queue()
        self.gui_process = None
        
        # Calculate absolute path to index.html
        self.backend_dir = os.path.dirname(os.path.abspath(__file__))
        # Get the root project directory 
        self.root_dir = os.path.dirname(self.backend_dir)
        self.html_path = os.path.join(self.root_dir, 'frontend', 'lwc', 'index.html')
        
        if not os.path.exists(self.html_path):
             # Fallback is generally not needed if the structure is correct, but let's keep a helpful error
             raise FileNotFoundError(f"Could not locate index.html. Searched: {self.html_path}")
        
        self.main_series_id = 'main'
        self.series = {} # id -> Series object
        
        # Tools
        self.toolbox = DrawingTool(self)

        # Create main series wrapper
        self.series[self.main_series_id] = Series(self, self.main_series_id, "Main")
        
        # Layout Management
        self.panes = {} # Per-chart panes: { chart_id: [{'id': scale_id, 'height': ratio}, ...] }
        self.main_margin_bottom = 0.05 # Default spacing
    
    def _process_polars_data(self, df):
        """
        Internal helper to automatically process Polars DataFrames.
        Delegates to shared utility.
        """
        return process_polars_data(df)
    
    def get_chart(self, chart_id):
        """
        Get a proxy object for a specific sub-chart.
        Allows calling methods like create_box() without manually passing chart_id.
        
        Args:
            chart_id (str): The ID of the chart (e.g., 'chart-0', 'chart-1').
            
        Returns:
            SubChart: A proxy object bound to the specified chart_id.
        """
        return SubChart(self, chart_id)

    def set_layout(self, layout_type='single'):
        """
        Set the chart layout (e.g., 'single', '2x1', '1x2', '2x2').
        Returns a list of SubChart objects available in this layout.
        """
        cmd = {
            'action': 'set_layout',
            'data': {
                'type': layout_type
            }
        }
        self._send_command(cmd)
        
        # Determine number of charts based on layout
        count = 1
        if layout_type in ['2x1', '1x2']:
            count = 2
        elif layout_type == '1p2':
            count = 3
        elif layout_type == '2x2':
            count = 4
            
        # Return proxies
        return [self.get_chart(f'chart-{i}') for i in range(count)]

    #########################################################################################################

    def create_line_series(self, name, color='#2962FF', width=2, style=0, visible=True, price_line_visible=True, last_value_visible=False, chart_id='chart-0'):
        """
        Create a new line series on the chart.
        
        Args:
            name (str): Name of the series.
            color (str): Hex color code.
            width (int): Line width.
            style (int): Line style (0=solid, 1=dotted, etc.).
            visible (bool): Initial visibility.
            price_line_visible (bool): Show horizontal price line.
            last_value_visible (bool): Show label for the last value.
            
        Returns:
            Series: The created Series object.
        """
        series_id = str(uuid.uuid4())
        cmd = {
            'action': 'create_line_series',
            'id': series_id,
            'name': name,
            'chartId': chart_id,
            'options': {
                'color': color,
                'lineWidth': width,
                'lineStyle': style,
                'visible': visible,
                'priceLineVisible': price_line_visible,
                'lastValueVisible': last_value_visible
            }
        }
        self._send_command(cmd)
            
        series = Series(self, series_id, name, chart_id)
        self.series[series_id] = series
        return series

    #########################################################################################################
    def create_candlestick_series(self, name, up_color='#26a69a', down_color='#ef5350', border_visible=True, wick_visible=True, chart_id='chart-0'):
        """
        Create a Candlestick Series on a specific chart.
        """
        series_id = str(uuid.uuid4())
        
        cmd = {
            'action': 'create_candlestick_series',
            'id': series_id,
            'name': name,
            'chartId': chart_id,
            'options': {
                'upColor': up_color,
                'downColor': down_color,
                'borderVisible': border_visible,
                'wickVisible': wick_visible
            }
        }
        self._send_command(cmd)
        
        series = Series(self, series_id, name, chart_id)
        self.series[series_id] = series
        return series

    #########################################################################################################
    def create_histogram_series(self, name, color='#26a69a', price_scale_id='right', visible=True, chart_id='chart-0'):
        """
        Create a new histogram series (e.g., for Volume).
        """
        series_id = str(uuid.uuid4())
        cmd = {
            'action': 'create_histogram_series',
            'id': series_id,
            'name': name,
            'chartId': chart_id,
            'options': {
                'color': color,
                'priceScaleId': price_scale_id,
                'visible': visible,
                'priceFormat': {
                     'type': 'volume',
                },
            }
        }
        self._send_command(cmd)
        
        series = Series(self, series_id, name, chart_id)
        self.series[series_id] = series
        return series
    #########################################################################################################
    def configure_price_scale(self, scale_id='right', mode='normal', auto_scale=True, invert_scale=False, scale_margin_top=0.2, scale_margin_bottom=0.2, chart_id='chart-0'):
        """
        Configure a price scale.
        mode: 'normal' (0), 'log' (1), 'percentage' (2), 'indexed' (3)
        """
        mode_map = {
            'normal': 0,
            'log': 1,
            'percentage': 2,
            'indexed': 3
        }
        
        cmd = {
            'action': 'configure_price_scale',
            'data': {
                'scaleId': scale_id,
                'mode': mode_map.get(mode, 0),
                'autoScale': auto_scale,
                'invertScale': invert_scale,
                'scaleMargins': {
                    'top': scale_margin_top,
                    'bottom': scale_margin_bottom,
                }
            },
            'chartId': chart_id
        }
        self._send_command(cmd)

    #########################################################################################################
    def create_sub_chart(self, name, color='#FF9800', type='line', width=1, height_ratio=0.2, chart_id='chart-0'):
        """
        Create a stacked indicator pane within a chart widget.
        Args:
           name: Series name.
           color: Series color.
           type: 'line' or 'histogram'.
           width: Line width (only for line type).
           height_ratio: Fraction of height to occupy (e.g., 0.2 for 20%).
           chart_id: Target chart widget (e.g., 'chart-0', 'chart-1', 'chart-2').
        """
        scale_id = str(uuid.uuid4())
        
        # Create Series FIRST so the scale exists
        series_id = str(uuid.uuid4())
        action = 'create_line_series' if type == 'line' else 'create_histogram_series'
        
        options = {
            'color': color,
            'priceScaleId': scale_id,
            'visible': True,
            'priceLineVisible': True,
            'lastValueVisible': True,
            'lineWidth': width
        }
        
        if type == 'histogram':
             options['priceFormat'] = {'type': 'volume'}
             
        cmd = {
            'action': action,
            'id': series_id,
            'name': name,
            'chartId': chart_id,
            'options': options
        }
        self._send_command(cmd)
        
        series = Series(self, series_id, name, chart_id)
        self.series[series_id] = series
        
        # Register pane for this chart
        if chart_id not in self.panes:
            self.panes[chart_id] = []
        self.panes[chart_id].append({'id': scale_id, 'height': height_ratio})
        
        # Calculate Layout — bottom-up stacking for this chart
        current_bottom = 0
        
        # Update all sub-panes for this chart
        for pane in reversed(self.panes[chart_id]):
             h = pane['height']
             pane_top_margin = 1.0 - (current_bottom + h)
             pane_bottom_margin = current_bottom
             
             self.configure_price_scale(scale_id=pane['id'], scale_margin_top=pane_top_margin, scale_margin_bottom=pane_bottom_margin, chart_id=chart_id)
             
             current_bottom += h
             
        # Update main price scale for this chart
        self.configure_price_scale(scale_id='right', scale_margin_top=0, scale_margin_bottom=current_bottom, chart_id=chart_id)
        
        return series


    def set_layout_toolbar_visibility(self, visible: bool):
        """
        Set the visibility of the layout toolbar.
        
        Args:
            visible (bool): True to show, False to hide.
        """
        cmd = {
            'action': 'set_layout_toolbar_visibility',
            'data': {
                'visible': visible
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def set_timeframe(self, tf):
        """
        Set the displayed timeframe label on the chart.
        
        Args:
            tf (str): The timeframe string to display.
        """
        cmd = {
            'action': 'set_timeframe',
            'data': tf
        }
        self._send_command(cmd)
    
    #########################################################################################################
    def show_notification(self, message: str, type: str = 'info', duration: int = 3000, text_color: str = None):
        """
        Show a toast notification on the chart.
        :param message: The text to display
        :param type: 'info', 'warning', 'error', or 'success' (styles must exist in css)
        :param duration: duration in ms
        :param text_color: custom text color (e.g. '#ff0000', 'red')
        """
        cmd = {
            'action': 'show_notification',
            'data': {
                'message': message,
                'type': type,
                'duration': duration,
                'text_color': text_color
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def set_timezone(self, timezone: str):
        """
        Configure chart settings, such as timezone.
        :param timezone: IANA timezone string (e.g., 'Asia/Kolkata', 'UTC', 'America/New_York')
        """
        cmd = {
            'action': 'set_timezone',
            'chartId': 'chart-0', # Global config usually applies to all or main, but strict mapping required
            'data': {
                'timezone': timezone
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def set_watermark(self, text: str, color: str = 'rgba(255, 255, 255, 0.1)', visible: bool = True, font_size: int = 48, chart_id='chart-0'):
        """
        Set the background watermark of the chart.
        """
        cmd = {
            'action': 'set_watermark',
            'chartId': chart_id,
            'data': {
                'text': text,
                'color': color,
                'visible': visible,
                'fontSize': font_size,
                'horzAlign': 'center',
                'vertAlign': 'center'
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def set_sync(self, enabled: bool = True):
        """
        Enable or disable synchronization (crosshair and time scale) between charts.
        """
        cmd = {
            'action': 'set_sync',
            'data': {
                'enabled': enabled
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def set_tooltip(self, enabled: bool = True):
        """
        Enable or disable floating tooltips on the chart.
        """
        cmd = {
            'action': 'set_tooltip',
            'data': {
                'enabled': enabled
            }
        }
        self._send_command(cmd)

    #########################################################################################################
    def hide_loading(self):
        """
        Hide the loading screen overlay.
        """
        cmd = {
            'action': 'hide_loading',
            'data': {}
        }
        self._send_command(cmd)

    #########################################################################################################
    def process_data(self, data, time_as_string=False):
        """
        Process data dictionary or list of dictionaries:
        1. Map 'date' key to 'time'.
        2. Normalize datetime objects/strings.
        3. Optionally format time as YYYY-MM-DD string.
        """
        if isinstance(data, list):
            for item in data:
                self.process_data(item, time_as_string)
            return

        val = data.pop('date', None)
        # If date wasn't there, check if time is there to process it
        if val is None:
            val = data.get('time')

        if val is None:
            return

        if time_as_string:
            data['time'] = timestamp_to_date_str(val)
        else:
            data['time'] = ensure_timestamp(val)
        
    #########################################################################################################
    def set_data(self, data, time_as_string=False, fit=False):
        """
        Set data for the main series. Validates and processes the input data first.
        
        Args:
           data (pl.DataFrame): The data to set.
           time_as_string (bool): If True, formats time as a YYYY-MM-DD string.
           fit (bool): If True, automatically fits content after setting data.
        """
        """Legacy wrapper for main series set_data"""
        if not isinstance(data, pl.DataFrame):
             raise TypeError("Data must be a Polars DataFrame")

        # Process data logic moved/simplified since we trust Polars
        # User is responsible for column renaming (date -> time) and timestamp format (seconds)
        # We just converting to dicts
        
        # Auto-convert dates
        data = self._process_polars_data(data)
        
        data_dicts = data.to_dicts()
        self.series[self.main_series_id].set_data(data) # Passes DF to Series.set_data which handles to_dicts
    
    #########################################################################################################
    def update(self, item, time_as_string=False):
        """
        Update the main series with a single data point.
        
        Args:
            item (pl.DataFrame): The new data point.
            time_as_string (bool): If True, formats time as a YYYY-MM-DD string.
        """
        """Legacy wrapper for main series update"""
        if not isinstance(item, pl.DataFrame):
            raise TypeError("Item must be a Polars DataFrame")
        # Series.update will handle _process_polars_data call
        self.series[self.main_series_id].update(item)
    
    #########################################################################################################
    def _send_series_data(self, series_id, data):
        """
        Internal method to construct and send a 'set_data' command for a specific series.
        """
        cmd = {
            'action': 'set_data',
            'id': series_id,
            'data': data
        }
        self._send_command(cmd)
    
    #########################################################################################################
    def _send_series_update(self, series_id, item):
        """
        Internal method to construct and send an 'update_data' command for a specific series.
        """
        cmd = {
            'action': 'update_data',
            'id': series_id,
            'data': item
        }
        self._send_command(cmd)
    
    #########################################################################################################
    def _send_command(self, cmd):
        """
        Push a command dictionary to the multiprocessing queue for the GUI process to handle.
        
        Args:
            cmd (dict): The command to send.
        """
        # We just push to queue. The GUI process will pick it up.
        self.queue.put(cmd)
    
    #########################################################################################################
    def show(self, block=False):
        """
        Show the chart window.
        :param block: If True, blocks execution until window is closed. 
                      If False (default), runs in background and returns immediately.
        """
        if self.gui_process and self.gui_process.is_alive():
            print("Chart is already running.")
            return

        self.gui_process = multiprocessing.Process(
            target=_gui_process, 
            args=(self.html_path, self.queue)
        )
        self.gui_process.start()
        
        if block:
            self.gui_process.join()

    def is_alive(self):
        """
        Check if the GUI process is still running.
        """
        if self.gui_process and self.gui_process.is_alive():
            return True
        return False
    
    #########################################################################################################
    def exit(self):
        """
        Signal the GUI process to exit and wait for it to terminate.
        """
        self.queue.put(None)
        if self.gui_process:
            self.gui_process.join()
            
    def zoom_to_range(self, start_time, end_time, chart_id='chart-0'):
        """
        Zoom the chart to a specific time range.
        Args:
            start_time: Start timestamp or date string.
            end_time: End timestamp or date string.
        """
        start = ensure_timestamp(start_time)
        end = ensure_timestamp(end_time)
        
        cmd = {
            'action': 'set_visible_range',
            'data': {
                'from': start,
                'to': end
            },
            'chartId': chart_id
        }
        self._send_command(cmd)

    def set_crosshair_mode(self, mode='normal', chart_id='chart-0'):
        """
        Set the crosshair mode.
        Args:
            mode (str): 'normal' or 'magnet'.
        """
        modes = {'normal': 1, 'magnet': 0}
        cmd = {
            'action': 'set_crosshair_mode',
            'data': {
                'mode': modes.get(mode, 1)
            },
            'chartId': chart_id
        }
        self._send_command(cmd)

    def screenshot(self, chart_id='chart-0'):
        """
        Trigger a screenshot download in the browser.
        """
        cmd = {
            'action': 'take_screenshot',
            'chartId': chart_id
        }
        self._send_command(cmd)
        

#########################################################################################################
