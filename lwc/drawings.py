import uuid


import polars as pl
from lwc.time_utils import ensure_timestamp as _ensure_timestamp, timestamp_to_date_str

#########################################################################################################

class PriceLine:
    """
    Represents a horizontal price line on the chart.
    """
    def __init__(self, tool, series_id, price, color, width=1, style=1, text='', axis_label_visible=True, chart_id='chart-0'):
        """
        Initialize the PriceLine.
        """
        self.tool = tool
        self.series_id = series_id
        self.chart_id = chart_id
        self.line_id = str(uuid.uuid4())
        self.color = color
        self.width = width
        self.style = style
        self.text = text
        self.axis_label_visible = axis_label_visible
        self.is_visible = False
        
        # Initial update
        self.update(price)

    def update(self, price):
        """
        Update the price of the line. If price is 0, the line is hidden/removed.
        """
        if price == 0:
            if self.is_visible:
                # Remove it
                cmd = {
                    'action': 'remove_price_line',
                    'line_id': self.line_id,
                    'chartId': self.chart_id
                }
                self.tool.chart._send_command(cmd)
                self.is_visible = False
        else:
            if self.is_visible:
                # Update it
                cmd = {
                    'action': 'update_price_line',
                    'line_id': self.line_id,
                    'chartId': self.chart_id,
                    'options': {'price': price}
                }
                self.tool.chart._send_command(cmd)
            else:
                # Create it
                cmd = {
                    'action': 'create_price_line',
                    'series_id': self.series_id,
                    'line_id': self.line_id,
                    'chartId': self.chart_id,
                    'options': {
                        'price': price,
                        'color': self.color,
                        'lineWidth': self.width,
                        'lineStyle': self.style,
                        'title': self.text,
                        'axisLabelVisible': self.axis_label_visible
                    }
                }
                self.tool.chart._send_command(cmd)
                self.is_visible = True

#########################################################################################################

class DrawingTool:
    """
    Manager for drawing shapes and markers on the chart.
    """
    def __init__(self, chart):
        """
        Initialize the DrawingTool.
        
        Args:
            chart (Chart): Reference to the parent Chart instance.
        """
        self.chart = chart
        self.markers = {}
        self.lines = {}
        self.boxes = {}
        self.positions = {}
        self.chart_positions = {} # chart_id -> pos_id
        self.category_index = {} # category -> set of box_ids
        self._last_position_state = None

    def sync_active_position(self, is_opened, start_time=None, entry_price=None, sl_price=None, tp_price=None, pos_type=None, end_time=None, chart_id='chart-0'):
        """
        Synchronize the active position on the chart.
        If is_opened is False, clear positions.
        If is_opened is True, draw position if different from last state.
        
        Args:
            is_opened (bool): Whether a position is currently open in the backend.
            start_time, entry_price, sl_price, tp_price, pos_type: Position details.
            end_time (optional): End time for the position.
            chart_id (str): Chart ID to draw on.
        """
        if not is_opened:
            if self._last_position_state == 'CLEARED':
                return
            self.clear_positions()
            self._last_position_state = 'CLEARED'
            return

        # Explicitly check for None values if opened (end_time is optional so not checked here)
        if any(x is None for x in [start_time, entry_price, sl_price, tp_price, pos_type]):
             print("Warning: Missing position data for open position")
             return

        current_state = (start_time, entry_price, sl_price, tp_price, pos_type, end_time, chart_id)
        
        # Check if we can just update an existing position on this specific chart
        existing_pos_id = self.chart_positions.get(chart_id)

        if existing_pos_id and existing_pos_id in self.positions:
             # Check if type matches
             existing_data = self.positions[existing_pos_id]
             expected_type = 'long' if pos_type == 'buy' else 'short'
             
             if existing_data.get('type') == expected_type:
                 # Update
                 self.update_position(existing_pos_id, 
                                      start_time=start_time,
                                      entry_price=entry_price,
                                      sl_price=sl_price,
                                      tp_price=tp_price,
                                      end_time=end_time)
                 self._last_position_state = 'ACTIVE'
                 return

             # If type doesn't match, we should remove the old one (or just create new on top? usually remove)
             self.remove_position(existing_pos_id)
        
        # Create new position for this chart
        if pos_type == 'buy':
            self.create_long_position(start_time, entry_price, sl_price, tp_price, end_time, chart_id=chart_id)
        else:
            self.create_short_position(start_time, entry_price, sl_price, tp_price, end_time, chart_id=chart_id)
        self._last_position_state = 'ACTIVE'
    #########################################################################################################

    def __create_position(self, start_time, entry_price, sl_price, tp_price, end_time=None, visible=True, type='long', quantity=1, chart_id='chart-0'):
        """
        Create a Long/Short position tool.
        """
        start_time = _ensure_timestamp(start_time)
        if end_time:
            end_time = _ensure_timestamp(end_time)
        
        # Check if position already exists for this chart
        if chart_id in self.chart_positions:
            old_pid = self.chart_positions[chart_id]
            # Verify if it really exists in positions dict before removing
            if old_pid in self.positions:
                self.remove_position(old_pid)
        
        pos_id = str(uuid.uuid4())
        self.chart_positions[chart_id] = pos_id
        
        data = {
            'id': pos_id,
            'start_time': start_time,
            'end_time': end_time,
            'entry_price': entry_price,
            'sl_price': sl_price,
            'tp_price': tp_price,
            'visible': visible,
            'type': type, # 'long' or 'short'
            'quantity': quantity,
            'chart_id': chart_id
        }
        
        self.positions[pos_id] = data
        
        cmd = {
            'action': 'create_position',
            'id': pos_id,
            'chartId': chart_id,
            'data': data
        }
        self.chart._send_command(cmd)
        return pos_id

    def clear_positions(self, chart_id=None):
        """
        Remove position tools from the chart.
        If chart_id is provided, only remove positions for that chart.
        """
        # Identify positions to remove
        to_remove_ids = []
        if chart_id:
            if chart_id in self.chart_positions:
                to_remove_ids.append(self.chart_positions[chart_id])
        else:
            # Clear all
            to_remove_ids = list(self.positions.keys())

        # Remove them locally
        for pid in to_remove_ids:
            if pid in self.positions:
                cid = self.positions[pid].get('chart_id')
                if cid and cid in self.chart_positions:
                     del self.chart_positions[cid]
                del self.positions[pid]

        if chart_id:
             for pid in to_remove_ids:
                 cmd = {
                    'action': 'remove_position',
                    'id': pid
                 }
                 self.chart._send_command(cmd)
        else:
            # Global clear
            self.chart_positions.clear() # double check clear
            cmd = {
                'action': 'remove_all_positions'
            }
            self.chart._send_command(cmd)

    def create_long_position(self, start_time, entry_price, sl_price, tp_price, end_time=None, quantity=1, chart_id='chart-0'):
        return self.__create_position(start_time, entry_price, sl_price, tp_price, end_time, type='long', quantity=quantity, chart_id=chart_id)

    def create_short_position(self, start_time, entry_price, sl_price, tp_price, end_time=None, quantity=1, chart_id='chart-0'):
        return self.__create_position(start_time, entry_price, sl_price, tp_price, end_time, type='short', quantity=quantity, chart_id=chart_id)

    def remove_position(self, pos_id):
        if pos_id in self.positions:
            chart_id = self.positions[pos_id].get('chart_id')
            if chart_id and chart_id in self.chart_positions:
                if self.chart_positions[chart_id] == pos_id:
                    del self.chart_positions[chart_id]
            del self.positions[pos_id]
        
        cmd = {
            'action': 'remove_position',
            'id': pos_id
        }
        self.chart._send_command(cmd)

    def update_position(self, pos_id, **kwargs):
        if pos_id in self.positions:
            self.positions[pos_id].update(kwargs)
            if 'start_time' in kwargs:
                self.positions[pos_id]['start_time'] = _ensure_timestamp(kwargs['start_time'])
            if 'end_time' in kwargs:
                self.positions[pos_id]['end_time'] = _ensure_timestamp(kwargs['end_time'])
        
        cmd = {
            'action': 'update_position',
            'id': pos_id,
            'data': kwargs
        }
        self.chart._send_command(cmd)

    def _resolve_chart_id(self, series_id, chart_id):
        """
        Helper to resolve chart_id from series_id if chart_id is None or default.
        """
        if chart_id is None or chart_id == 'chart-0':
            # Try to lookup series to get exact chart_id
             if series_id in self.chart.series:
                 return self.chart.series[series_id].chart_id
        return chart_id if chart_id else 'chart-0'

    def add_marker(self, series_id, time, position='aboveBar', color='#2196F3', shape='arrowDown', text='', marker_id=None, timeframe=None, chart_id=None):
        """
        Add a marker to a specific series.
        """
        chart_id = self._resolve_chart_id(series_id, chart_id)

        # Handle 1d formatting to prevent LWC mismatch
        if timeframe == '1d' and hasattr(time, 'strftime'):
             time = time.strftime('%Y-%m-%d')

        if not marker_id:
            marker_id = str(time)
        
        data = {
            'id': marker_id,
            'time': _ensure_timestamp(time),
            'position': position,
            'color': color,
            'shape': shape,
            'text': text,
            'series_id': series_id
        }
        self.markers[marker_id] = data


        cmd = {
            'action': 'add_marker',
            'series_id': series_id,
            'chartId': chart_id,
            'data': {k: v for k, v in data.items() if k != 'series_id'}
        }
        self.chart._send_command(cmd)
        return marker_id
    #########################################################################################################


    def remove_marker(self, series_id, marker_id):
        """
        Remove a marker from a series.
        
        Args:
            series_id (str): The ID of the series.
            marker_id (str): The ID of the marker to remove.
        """
        if marker_id in self.markers:
            del self.markers[marker_id]

        cmd = {
            'action': 'remove_marker',
            'series_id': series_id,
            'marker_id': marker_id
        }
        self.chart._send_command(cmd)
    #########################################################################################################

    def update_marker(self, series_id, marker_id, **kwargs):
        """
        Update properties of an existing marker (e.g. text, color, position, time).
        """
        if marker_id in self.markers:
            self.markers[marker_id].update(kwargs)
            if 'time' in kwargs:
                self.markers[marker_id]['time'] = _ensure_timestamp(kwargs['time'])

        cmd = {
            'action': 'update_marker',
            'series_id': series_id,
            'marker_id': marker_id,
            'data': kwargs
        }
        self.chart._send_command(cmd)
    #########################################################################################################

    def create_horizontal_line(self, series_id, price, color='#F44336', 
    width=1, style=1, text='', axis_label_visible=True, chart_id=None):
        """
        Create a horizontal price line on a series.
        """
        chart_id = self._resolve_chart_id(series_id, chart_id)
        
        line = PriceLine(self, series_id, price, color, width, style, text, axis_label_visible, chart_id)
        self.lines[line.line_id] = line
        return line
    #########################################################################################################

    def remove_horizontal_line(self, line_id):
        """
        Remove a horizontal price line.
        
        Args:
            line_id (str): The ID of the line to remove.
        """
        if line_id in self.lines:
            del self.lines[line_id]

        cmd = {
            'action': 'remove_price_line',
            'line_id': line_id
        }
        self.chart._send_command(cmd)
    #########################################################################################################

    def update_horizontal_line(self, line_id, **kwargs):
        """
        Update properties of a price line (e.g. price, color, title).
        """
        # If tracking lines, one might want to update the stored object or data here.
        # However, PriceLine object reference is stored, but its attributes aren't automatically updated 
        # unless we update the object instance or store data in a dict.
        # Since self.lines stores PriceLine objects, and PriceLine doesn't have a generic update_props method
        # that takes kwargs (it has specific update(price)), we just leave it for now unless we refactor PriceLine.
        # But we at least track existence.
        
        cmd = {
            'action': 'update_price_line',
            'line_id': line_id,
            'options': kwargs
        }
        self.chart._send_command(cmd)
    #########################################################################################################

    def create_box(self, start_time, start_price, end_time, end_price, color='rgba(33, 150, 243, 0.2)', 
    border_color='#2196F3', border_width=1, border_style='solid', text='', text_color='#ffffff', visible=True, time_as_string=False, infinite=False, category=None, chart_id='chart-0'):
        """
        Draw a rectangle box on the chart.
        
        Args:
            start_time: Start time of the box.
            start_price: Top/Bottom price of the box.
            end_time: End time of the box.
            end_price: Bottom/Top price of the box.
            color (str): Fill color.
            border_color (str): Border color.
            border_width (int): Border width.
            border_style (str): Border style.
            text (str): Optional text inside the box.
            text_color (str): Color of the text.
            visible (bool): Initial visibility.
            time_as_string (bool): If True, treats time inputs as strings or formats them.
            infinite (bool): If True, extends the box infinitely to the right.
            category (str): Optional category for grouping boxes (e.g., 'supply', 'demand').
            chart_id (str): The ID of the chart to add the box to.
            
        Returns:
            str: The box_id.
        """
        if time_as_string:
            start_time = timestamp_to_date_str(start_time)
            end_time = timestamp_to_date_str(end_time)
        else:
             start_time = _ensure_timestamp(start_time)
             end_time = _ensure_timestamp(end_time)

        box_id = f"{chart_id}_{category}_{start_time}_{end_time}" if category else f"{chart_id}_{start_time}_{end_time}"
        
        # Category Logic: Remove old boxes of same category using index for partial optimization
        if category:
            if category in self.category_index:
                # Create a list copy to iterate safely
                to_remove = list(self.category_index[category])
                for bid in to_remove:
                    if bid != box_id:
                        self.remove_box(bid)

        if box_id in self.boxes:
            # Update category if missing
            if category and 'category' not in self.boxes[box_id]:
                self.boxes[box_id]['category'] = category
                # Update index
                if category not in self.category_index:
                    self.category_index[category] = set()
                self.category_index[category].add(box_id)
            return box_id
        
        box_data = {
            'id': box_id,
            'start_time': start_time,
            'top_price': start_price,
            'end_time': end_time,
            'bottom_price': end_price,
            'color': color,
            'border_color': border_color,
            'border_width': border_width,
            'border_style': border_style,
            'text': text,
            'text_color': text_color,
            'visible': visible,
            'infinite': infinite,
            'category': category
        }
        self.boxes[box_id] = box_data
        
        if category:
            if category not in self.category_index:
                self.category_index[category] = set()
            self.category_index[category].add(box_id)

        cmd = {
            'action': 'create_box',
            'id': box_id,
            'chartId': chart_id,
            'data': box_data
        }
        self.chart._send_command(cmd)
        return box_id
    #########################################################################################################

    def remove_box(self, box_id):
        """
        Remove a box from the chart.
        
        Args:
            box_id (str): The ID of the box to remove.
        """
        if box_id in self.boxes:
            # Update index
            cat = self.boxes[box_id].get('category')
            if cat and cat in self.category_index:
                self.category_index[cat].discard(box_id)
                if not self.category_index[cat]:
                    del self.category_index[cat]
            del self.boxes[box_id]

        cmd = {
            'action': 'remove_box',
            'id': box_id
        }
        self.chart._send_command(cmd)
    #########################################################################################################

    def update_box(self, box_id, **kwargs):
        """
        Update properties of a box (e.g. color, coordinates).
        """
        if box_id in self.boxes:
            # Map start_price/end_price to top_price/bottom_price for consistency
            if 'start_price' in kwargs:
                kwargs['top_price'] = kwargs.pop('start_price')
            if 'end_price' in kwargs:
                kwargs['bottom_price'] = kwargs.pop('end_price')

            self.boxes[box_id].update(kwargs)
            if 'start_time' in kwargs:
                 self.boxes[box_id]['start_time'] = _ensure_timestamp(kwargs['start_time'])
            if 'end_time' in kwargs:
                 self.boxes[box_id]['end_time'] = _ensure_timestamp(kwargs['end_time'])

        cmd = {
            'action': 'update_box',
            'id': box_id,
            'data': kwargs
        }
        self.chart._send_command(cmd)

    def _create_line_tool(self, type, start_time, start_price, end_time, end_price, color='#2196F3', width=2, style=0, visible=True, text='', extended=False, chart_id='chart-0'):
        """
        Internal helper to create line tools (trendline, ray, fib).
        """
        start_time = _ensure_timestamp(start_time)
        end_time = _ensure_timestamp(end_time)
        
        tool_id = str(uuid.uuid4())
        
        data = {
            'id': tool_id,
            'type': type,
            'start_time': start_time,
            'start_price': start_price,
            'end_time': end_time,
            'end_price': end_price,
            'color': color,
            'width': width,
            'style': style,
            'visible': visible,
            'text': text,
            'extended': extended
        }
        
        cmd = {
            'action': 'create_line_tool',
            'id': tool_id,
            'chartId': chart_id,
            'data': data
        }
        self.chart._send_command(cmd)
        return tool_id

    def create_trendline(self, start_time, start_price, end_time, end_price, color='#2196F3', width=2, style=0, visible=True, text='', chart_id='chart-0'):
        """
        Create a Trendline (Line Segment) between two points.
        """
        return self._create_line_tool('trendline', start_time, start_price, end_time, end_price, color, width, style, visible, text=text, chart_id=chart_id)

    def create_ray_line(self, start_time, start_price, end_time, end_price, color='#2196F3', width=2, style=0, visible=True, text='', chart_id='chart-0'):
        """
        Create a Ray Line starting at P1 and passing through P2 to infinity.
        """
        return self._create_line_tool('ray', start_time, start_price, end_time, end_price, color, width, style, visible, text=text, chart_id=chart_id)

    def create_fib_retracement(self, start_time, start_price, end_time, end_price, color='#2196F3', visible=True, extended=False, chart_id='chart-0'):
        """
        Create a Fibonacci Retracement tool between two points.
        """
        return self._create_line_tool('fib', start_time, start_price, end_time, end_price, color, 1, 0, visible, extended=extended, chart_id=chart_id)

    def remove_line_tool(self, tool_id):
        """
        Remove a line tool (trendline, ray, fib).
        """
        cmd = {
            'action': 'remove_line_tool',
            'id': tool_id
        }
        self.chart._send_command(cmd)
#########################################################################################################
