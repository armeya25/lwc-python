// Global Error Handler
window.onerror = function (msg, url, line, col, error) {
    const loadingDiv = document.getElementById('loading');
    if (loadingDiv) {
        loadingDiv.innerHTML += `<div style="color:red; font-size:16px; margin-top:10px;">
            Error: ${msg}<br>
            Line: ${line}:${col}
        </div>`;
    }
    console.error("Global Error:", msg, url, line, col, error);
    return false;
};

function updateStatus(text) {
    const el = document.getElementById('loading');
    if (el) el.innerText = text;
}

function showNotification(message, type = 'info', duration = 3000, textColor = null) {
    // Create notification container if it doesn't exist
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column-reverse;
            gap: 10px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;

    // Base styles
    let bgColor = 'rgba(40, 40, 40, 0.95)';
    let borderColor = '#555';
    let defaultTextColor = '#fff';

    // Type-specific colors
    if (type === 'success') {
        bgColor = 'rgba(46, 189, 133, 0.15)';
        borderColor = '#2ebd85';
        defaultTextColor = '#2ebd85';
    } else if (type === 'error') {
        bgColor = 'rgba(246, 70, 93, 0.15)';
        borderColor = '#f6465d';
        defaultTextColor = '#f6465d';
    } else if (type === 'warning') {
        bgColor = 'rgba(255, 152, 0, 0.15)';
        borderColor = '#ff9800';
        defaultTextColor = '#ff9800';
    }

    notification.style.cssText = `
        background: ${bgColor};
        border-left: 3px solid ${borderColor};
        color: ${textColor || defaultTextColor};
        padding: 12px 16px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        pointer-events: auto;
        animation: slideIn 0.3s ease-out;
        max-width: 350px;
        word-wrap: break-word;
    `;

    notification.textContent = message;
    container.appendChild(notification);

    // Auto-remove after duration
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, duration);
}

updateStatus("Initializing Global State...");

// Global state
window.charts = new Map();       // chartId -> chartInstance
window.seriesMap = new Map();    // seriesId -> seriesInstance
window.chartSeriesMap = new Map(); // chartId -> Set<seriesId>
window.chartTimeZone = 'Asia/Kolkata'; // Default
window.tooltipEnabled = true;
window.syncEnabled = true;       // Crosshair/Time sync

let isReady = false;

// Helper to find a series for a chart (for plugins)
window.getSeriesForChart = function (chartId) {
    const seriesSet = window.chartSeriesMap.get(chartId);
    if (seriesSet && seriesSet.size > 0) {
        // Return first one found
        const firstId = seriesSet.values().next().value;
        return window.seriesMap.get(firstId);
    }
    // Fallback?
    return window.seriesMap.get('main');
};

// --- Layout Management ---
// --- Layout Management ---
window.currentLayout = 'single';

window.changeLayout = function (type) {
    createLayout(type);

    // Notify backend if needed? Not stricly necessary as frontend drives view now,
    // but backend might want to know. For now, frontend-only switch is fine.
    // If we want backend to know, we can send a message.
}

// --- Sync Manager ---
const SyncManager = {
    isSyncing: false,
    charts: [],
    activeChart: null,

    // Performance: Reusable objects to avoid GC
    _rafId: null,
    lastMaster: null,
    lastHigh: null,
    lastLow: null,

    register: function (chart, container) {
        if (this.charts.includes(chart)) return;
        this.charts.push(chart);

        // Time Scale Sync
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (this.isSyncing) return;
            if (!range) return;

            this.isSyncing = true;
            try {
                this.charts.forEach(otherChart => {
                    if (otherChart !== chart) {
                        otherChart.timeScale().setVisibleLogicalRange(range);
                    }
                });
            } finally {
                this.isSyncing = false;
            }
        });

        // Price Scale Sync (Y-Axis)
        // Price Scale Sync (Y-Axis) via Polling + Autoscale Override
        // Strategy: 
        // 1. Read visible range using coordinateToPrice(0) [top] and coordinateToPrice(height) [bottom].
        // 2. Set range on others using calculateAutoscaleInfo series option.
        // 3. ONLY the "Active" chart (under mouse) updates others to prevent feedback loops.

        // Track active chart
        if (container) {
            container.addEventListener('mouseenter', () => {
                this.activeChart = chart;
            });
        }

        // Start Master Loop if not running
        if (!this._rafId) {
            this.startLoop();
        }

        // Crosshair Sync
        chart.subscribeCrosshairMove((param) => {
            if (this.isSyncing) return;

            this.isSyncing = true;
            try {
                this.charts.forEach(otherChart => {
                    if (otherChart !== chart) {
                        // Optimization: Check bounds cheaply before complex logic
                        if (!param.time || param.point === undefined || param.point.x < 0) {
                            otherChart.clearCrosshairPosition();
                            return;
                        }

                        // Just sync time for now, as price sync is tricky with different scales
                        // We locate the main series of the other chart to anchor the crosshair
                        let targetChartId = null;
                        for (const [id, c] of window.charts.entries()) {
                            if (c === otherChart) { targetChartId = id; break; }
                        }

                        if (targetChartId) {
                            // Cache series lookup? For now direct lookup is fast enough for mousemove?
                            // Optimization: window.getSeriesForChart could be memoized or map-based access
                            const series = window.getSeriesForChart(targetChartId);
                            if (series) {
                                otherChart.setCrosshairPosition(NaN, param.time, series);
                            }
                        }
                    }
                });
            } catch (err) {
                console.error(err);
            } finally {
                this.isSyncing = false;
            }
        });
    },

    startLoop: function () {
        // Optimized Read/Write Batching Loop
        const loop = () => {
            this._rafId = requestAnimationFrame(loop);

            if (this.isSyncing) return;

            // 1. Identification Phase: Who is Master?
            const master = this.activeChart;
            if (!master) return; // No active interaction?

            // 2. READ Phase: Read Master State ONLY
            // We only need to read the master's range. We don't read slaves.
            const ps = master.priceScale('right');
            const height = master.options().height || 0;

            let targetLow = null;
            let targetHigh = null;

            if (height > 0 && ps && typeof ps.coordinateToPrice === 'function') {
                const hStart = ps.coordinateToPrice(1);
                const hEnd = ps.coordinateToPrice(height - 1);
                if (hStart !== null && hEnd !== null) {
                    targetHigh = hStart;
                    targetLow = hEnd;
                }
            }

            if (targetHigh === null || targetLow === null) return;

            // Optimization: Detect if change actually happened?
            // storing 'lastBroadcastRange' on SyncManager
            // BUT: coordinateToPrice is fast. The expensive part is applying options.
            // Let's check difference.
            if (this.lastMaster === master && this.lastHigh === targetHigh && this.lastLow === targetLow) {
                return; // Nothing changed
            }

            this.lastMaster = master;
            this.lastHigh = targetHigh;
            this.lastLow = targetLow;

            // 3. WRITE Phase: Apply to Slaves
            this.isSyncing = true;
            try {
                this.charts.forEach(otherChart => {
                    if (otherChart !== master) {
                        // Find series
                        let targetChartId = null;
                        // Map lookup is O(N) where N=4. Fast.
                        for (const [id, c] of window.charts.entries()) {
                            if (c === otherChart) { targetChartId = id; break; }
                        }

                        if (targetChartId) {
                            const seriesSet = window.chartSeriesMap.get(targetChartId);
                            if (seriesSet) {
                                let updated = false;
                                seriesSet.forEach(sid => {
                                    const s = window.seriesMap.get(sid);
                                    if (s) {
                                        s.applyOptions({
                                            autoscaleInfoProvider: () => ({
                                                priceRange: {
                                                    minValue: targetLow,
                                                    maxValue: targetHigh,
                                                },
                                            }),
                                        });
                                        updated = true;
                                    }
                                });
                                if (updated) {
                                    otherChart.priceScale('right').applyOptions({ autoScale: true });
                                }
                            }
                        }
                    }
                });
            } finally {
                this.isSyncing = false;
            }
        };
        this._rafId = requestAnimationFrame(loop);
    }
};

function createLayout(type) {
    window.currentLayout = type;
    const container = document.getElementById('chart-container');
    container.className = `layout-${type}`;

    let needed = 1;
    if (type === '2x1' || type === '1x2') needed = 2; // Note: 2x1 is Vertical Split (2 columns)
    if (type === '1p2') needed = 3; // Hybrid 1 Top, 2 Bottom
    if (type === '2x2') needed = 4;

    // Ensure we have enough charts
    for (let i = 0; i < 4; i++) {
        const chartId = `chart-${i}`;
        let cell = document.getElementById(`chart-cell-${i}`);

        if (i < needed) {
            // Need this chart
            if (!cell) {
                // Create logic
                cell = document.createElement('div');
                cell.className = 'chart-cell';
                cell.id = `chart-cell-${i}`;
                container.appendChild(cell);

                const chart = LightweightCharts.createChart(cell, {
                    layout: {
                        background: { color: 'transparent' },
                        textColor: '#d1d4dc',
                    },
                    grid: {
                        vertLines: { color: '#161619' },
                        horzLines: { color: '#161619' },
                    },
                    crosshair: {
                        mode: 0, // 0 = Normal (free crosshair), 1 = Magnet (snaps to candles)
                        horzLine: { visible: true, labelVisible: true },
                    },
                    width: cell.clientWidth,
                    height: cell.clientHeight,
                    localization: {
                        timeFormatter: (businessDayOrTimestamp) => {
                            if (typeof businessDayOrTimestamp === 'number') {
                                const date = new Date(businessDayOrTimestamp * 1000);
                                return date.toLocaleString('en-GB', {
                                    timeZone: window.chartTimeZone,
                                    day: 'numeric', month: 'short', year: '2-digit',
                                    hour: '2-digit', minute: '2-digit', hour12: false
                                }).replace(',', '');
                            }
                            return businessDayOrTimestamp;
                        }
                    },
                    timeScale: {
                        timeVisible: true,
                        secondsVisible: false,
                        tickMarkFormatter: (time) => {
                            if (typeof time === 'number') return new Date(time * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
                            if (typeof time === 'string') return new Date(time).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
                            return "";
                        }
                    }
                });

                window.charts.set(chartId, chart);

                // Sync
                if (window.syncEnabled) {
                    SyncManager.register(chart, cell);
                }

                // --- Per-Chart HUD (Legend + Tooltip) ---
                const hud = document.createElement('div');
                hud.className = 'chart-hud';

                const legend = document.createElement('div');
                legend.className = 'chart-legend collapsed';

                const legendHeader = document.createElement('div');
                legendHeader.className = 'chart-legend-header';
                legendHeader.innerHTML = `
                    <span>Legend</span>
                    <span class="toggle-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </span>
                `;
                legendHeader.onclick = () => legend.classList.toggle('collapsed');

                const legendContentDiv = document.createElement('div');
                legendContentDiv.className = 'chart-legend-content';

                legend.appendChild(legendHeader);
                legend.appendChild(legendContentDiv);

                const tooltip = document.createElement('div');
                tooltip.className = 'floating-tooltip';

                hud.appendChild(legend);
                hud.appendChild(tooltip);
                cell.appendChild(hud);

                // --- Scale Controls ---
                const controls = document.createElement('div');
                controls.className = 'chart-controls-bottom gpu-layer';
                controls.innerHTML = `
                    <div class="control-btn" data-type="auto" title="Auto Scale">Auto</div>
                    <div class="control-btn" data-type="log" title="Logarithmic">Log</div>
                    <div class="control-btn" data-type="pct" title="Percentage">%</div>
                `;
                cell.appendChild(controls);

                // Control Logic
                controls.querySelectorAll('.control-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const type = btn.dataset.type;
                        const scale = chart.priceScale('right');

                        // Reset others if mutually exclusive? Log/Pct are mutually exclusive usually.
                        // Auto is independent action.

                        if (type === 'auto') {
                            scale.applyOptions({ autoScale: true });
                            // Flash active briefly
                            btn.classList.add('active');
                            setTimeout(() => btn.classList.remove('active'), 200);
                        }
                        else if (type === 'log') {
                            const isLog = btn.classList.toggle('active');
                            controls.querySelector('[data-type="pct"]').classList.remove('active');
                            scale.applyOptions({ mode: isLog ? 1 : 0 }); // 1 = Log, 0 = Normal
                        }
                        else if (type === 'pct') {
                            const isPct = btn.classList.toggle('active');
                            controls.querySelector('[data-type="log"]').classList.remove('active');
                            scale.applyOptions({ mode: isPct ? 2 : 0 }); // 2 = Percentage
                        }
                    });
                });

                chart.subscribeCrosshairMove(param => {
                    if (!window.tooltipEnabled) {
                        tooltip.style.opacity = '0';
                        return;
                    }
                    if (
                        param.point === undefined ||
                        !param.time ||
                        param.point.x < 0 ||
                        param.point.x > cell.clientWidth ||
                        param.point.y < 0 ||
                        param.point.y > cell.clientHeight
                    ) {
                        tooltip.style.opacity = '0';
                        return;
                    }

                    // Find OHLC Series for this Chart
                    let ohlcSeriesId = null;
                    const seriesSet = window.chartSeriesMap.get(chartId);
                    if (seriesSet) {
                        // Heuristic: The first series is usually the main price series (or we could store main series ID)
                        // For now, iterate and take the first one or prioritize Line/Candlestick
                        ohlcSeriesId = Array.from(seriesSet)[0];
                    }

                    if (!ohlcSeriesId) {
                        tooltip.style.opacity = '0';
                        return;
                    }

                    const series = window.seriesMap.get(ohlcSeriesId);
                    const data = param.seriesData.get(series);

                    if (data) {
                        let open, high, low, close, colorClass;
                        // Handle LineSeries (value) vs Candlestick (open,high,low,close)
                        if (data.value !== undefined) {
                            open = high = low = close = data.value;
                            colorClass = '';
                        } else {
                            open = data.open;
                            high = data.high;
                            low = data.low;
                            close = data.close;
                            colorClass = close >= open ? 'up' : 'down';
                        }

                        const dateStr = new Date(param.time * 1000).toLocaleString('en-GB', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
                        });

                        const symbol = series._name || 'Chart';
                        tooltip.innerHTML = `
                            <div class="tooltip-header">${symbol} • ${dateStr}</div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Open</span>
                                <span class="tooltip-value ${colorClass}">${open.toFixed(2)}</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">High</span>
                                <span class="tooltip-value ${colorClass}">${high.toFixed(2)}</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Low</span>
                                <span class="tooltip-value ${colorClass}">${low.toFixed(2)}</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Close</span>
                                <span class="tooltip-value ${colorClass}">${close.toFixed(2)}</span>
                            </div>
                        `;
                        tooltip.style.opacity = '1';
                    } else {
                        tooltip.style.opacity = '0';
                    }
                });

                // --- End of Chart Setup ---

                // Initialize Plugins
                if (typeof BoxManager !== 'undefined') BoxManager.init(chartId, cell);
                if (typeof PositionToolManager !== 'undefined') PositionToolManager.init(chartId, cell);
                if (typeof LineToolManager !== 'undefined') LineToolManager.init(chartId, cell);
            }

            // Ensure visible
            cell.style.display = 'block';

            // Resize to fit new grid
            requestAnimationFrame(() => {
                setTimeout(() => {
                    const chart = window.charts.get(chartId);
                    if (chart) {
                        chart.applyOptions({ width: cell.clientWidth, height: cell.clientHeight });
                        chart.timeScale().fitContent(); // Ensure data fits
                    }
                }, 50);
            });

        } else {
            // Do not need this chart, hide it
            if (cell) {
                cell.style.display = 'none';
            }
        }
    }
}

window.addEventListener('resize', () => {
    window.charts.forEach((chart, id) => {
        // Only resize visible ones?
        const cell = document.getElementById(id.replace('chart-', 'chart-cell-'));
        if (cell && cell.style.display !== 'none') {
            chart.applyOptions({ width: cell.clientWidth, height: cell.clientHeight });
        }
    });
});

// --- Command Queue System (Optimization) ---
const CommandQueue = {
    queue: [],
    isProcessing: false,
    BUDGET_MS: 8, // Max time per frame to process commands

    push: function (cmd) {
        this.queue.push(cmd);
        if (!this.isProcessing) {
            this.isProcessing = true;
            requestAnimationFrame(() => this.process());
        }
    },

    process: function () {
        const start = performance.now();

        while (this.queue.length > 0) {
            // Check budget
            if (performance.now() - start > this.BUDGET_MS) {
                // Yield to renderer, continue next frame
                requestAnimationFrame(() => this.process());
                return;
            }

            const cmd = this.queue.shift();
            try {
                processCommandSync(cmd);
            } catch (e) {
                console.error("Command execution error:", e, cmd);
            }
        }

        this.isProcessing = false;
    }
};

// Global Command Handler (Entry Point)
window.handleCommand = function (cmd) {
    CommandQueue.push(cmd);
};

// Rename original handleCommand to internal function
function processCommandSync(cmd) {
    try {
        if (typeof cmd === 'string') cmd = JSON.parse(cmd);

        if (cmd.action === 'configure_chart') {
            // ... (keep timezone logic if needed globally or per chart)
            return;
        }

        if (cmd.action === 'set_layout') {
            createLayout(cmd.data.type);
            return;
        }

        console.log("CMD RECEIVED:", cmd.action, cmd);

        if (!isReady) {
            console.warn("Not ready, ignoring:", cmd.action);
            return;
        }

        // Determine Target Chart
        const chartId = cmd.chartId || 'chart-0';
        const targetChart = window.charts.get(chartId);

        if (!targetChart && cmd.action.includes('create_')) {
            console.warn(`Target chart ${chartId} not found for ${cmd.action}`);
            // Fallback or return? Return for now.
            return;
        }

        switch (cmd.action) {
            case 'create_line_series':
                if (window.seriesMap.has(cmd.id)) return;
                const lineSeries = targetChart.addSeries(LightweightCharts.LineSeries, cmd.options);
                window.seriesMap.set(cmd.id, lineSeries);

                // Track mapping
                if (!window.chartSeriesMap.has(chartId)) window.chartSeriesMap.set(chartId, new Set());
                window.chartSeriesMap.get(chartId).add(cmd.id);

                addLegendItem(chartId, cmd.id, cmd.name, cmd.options.color);
                break;

            case 'create_candlestick_series':
                if (window.seriesMap.has(cmd.id)) return;
                const candleSeries = targetChart.addSeries(LightweightCharts.CandlestickSeries, cmd.options);
                candleSeries._name = cmd.name;
                window.seriesMap.set(cmd.id, candleSeries);

                // Track mapping
                if (!window.chartSeriesMap.has(chartId)) window.chartSeriesMap.set(chartId, new Set());
                window.chartSeriesMap.get(chartId).add(cmd.id);
                addLegendItem(chartId, cmd.id, cmd.name, cmd.options.upColor);
                break;

            case 'create_histogram_series':
                if (window.seriesMap.has(cmd.id)) return;
                const histSeries = targetChart.addSeries(LightweightCharts.HistogramSeries, cmd.options);
                window.seriesMap.set(cmd.id, histSeries);

                // Track mapping
                if (!window.chartSeriesMap.has(chartId)) window.chartSeriesMap.set(chartId, new Set());
                window.chartSeriesMap.get(chartId).add(cmd.id);

                addLegendItem(chartId, cmd.id, cmd.name, cmd.options.color);
                break;

            case 'set_data':
                const s1 = window.seriesMap.get(cmd.id);
                if (s1) {
                    s1.setData(cmd.data);
                    // fitContent handled separately or via option

                    // Auto-hide loading screen when data arrives
                    const loading = document.getElementById('loading');
                    if (loading && loading.style.opacity !== '0') {
                        loading.style.opacity = '0';
                        setTimeout(() => loading.style.display = 'none', 500);
                    }
                    // Sync plugins
                    if (typeof BoxManager !== 'undefined') BoxManager.updatePositions();
                    if (typeof PositionToolManager !== 'undefined') PositionToolManager.updatePositions();
                    if (typeof LineToolManager !== 'undefined') LineToolManager.updatePositions();
                }
                break;

            case 'update_data':
                const s2 = window.seriesMap.get(cmd.id);
                if (s2) s2.update(cmd.data);
                break;

            case 'fit_content':
                if (targetChart) targetChart.timeScale().fitContent();
                break;

            case 'set_visible_range':
                if (targetChart) targetChart.timeScale().setVisibleRange(cmd.data);
                break;

            case 'create_position':
                if (typeof PositionToolManager !== 'undefined') PositionToolManager.create(chartId, cmd.id, cmd.data);
                break;

            case 'create_box':
                if (typeof BoxManager !== 'undefined') BoxManager.createBox(chartId, cmd.id, cmd.data);
                break;

            case 'create_line_tool':
                if (typeof LineToolManager !== 'undefined') LineToolManager.create(chartId, cmd.id, cmd.data);
                break;

            case 'update_line_tool':
                if (typeof LineToolManager !== 'undefined') LineToolManager.update(cmd.id, cmd.data);
                break;

            case 'remove_line_tool':
                if (typeof LineToolManager !== 'undefined') LineToolManager.remove(cmd.id);
                break;

            case 'add_marker':
                if (typeof MarkerManager !== 'undefined') MarkerManager.addMarker(cmd.series_id, cmd.data);
                break;
            case 'remove_marker':
                if (typeof MarkerManager !== 'undefined') MarkerManager.removeMarker(cmd.series_id, cmd.marker_id);
                break;
            case 'update_marker':
                if (typeof MarkerManager !== 'undefined') MarkerManager.updateMarker(cmd.series_id, cmd.marker_id, cmd.data);
                break;

            case 'create_price_line':
                if (typeof PriceLineManager !== 'undefined') PriceLineManager.create(cmd.series_id, cmd.line_id, cmd.options);
                break;
            case 'remove_price_line':
                if (typeof PriceLineManager !== 'undefined') PriceLineManager.remove(cmd.line_id);
                break;
            case 'update_price_line':
                if (typeof PriceLineManager !== 'undefined') PriceLineManager.update(cmd.line_id, cmd.options);
                break;

            case 'take_screenshot':
                if (targetChart) {
                    const canvas = targetChart.takeScreenshot();
                    const a = document.createElement('a');
                    a.href = canvas.toDataURL();
                    a.download = `chart_${chartId}_${new Date().toISOString()}.png`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
                break;

            case 'set_watermark':
                if (targetChart) {
                    // LWC v5: watermark is now a plugin, not a chart option.
                    // createTextWatermark attaches to a specific pane.
                    if (typeof LightweightCharts.createTextWatermark === 'function') {
                        const pane = targetChart.panes()[0];
                        if (pane) {
                            LightweightCharts.createTextWatermark(pane, {
                                horzAlign: cmd.data.horzAlign || 'center',
                                vertAlign: cmd.data.vertAlign || 'center',
                                lines: [
                                    {
                                        text: cmd.data.text,
                                        color: cmd.data.color || 'rgba(255, 255, 255, 0.1)',
                                        fontSize: cmd.data.fontSize || 48,
                                        fontWeight: 'bold',
                                    }
                                ],
                            });
                        }
                    }
                }
                break;

            case 'update_position':
                if (typeof PositionToolManager !== 'undefined') {
                    PositionToolManager.update(cmd.id, cmd.data);
                }
                break;

            case 'remove_position':
                if (typeof PositionToolManager !== 'undefined') {
                    PositionToolManager.remove(cmd.id);
                }
                break;

            case 'set_tooltip':
                window.tooltipEnabled = !!cmd.data.enabled;
                if (!window.tooltipEnabled) {
                    // Hide all existing tooltip elements immediately
                    document.querySelectorAll('.floating-tooltip').forEach(el => {
                        el.style.opacity = '0';
                    });
                }
                break;

            // ─── Box Drawing (remove / update ─ create handled above) ──────────
            case 'remove_box':
                if (typeof BoxManager !== 'undefined') BoxManager.removeBox(cmd.id);
                break;

            case 'update_box':
                if (typeof BoxManager !== 'undefined') BoxManager.updateBox(cmd.id, cmd.data);
                break;

            case 'configure_price_scale': {
                const chart = window.charts.get(cmd.chartId || 'chart-0');
                if (!chart) break;
                const d = cmd.data;
                const scaleId = d.scaleId || 'right';

                const scaleOptions = {
                    visible: true,
                    mode: d.mode !== undefined ? d.mode : 0,
                    autoScale: d.autoScale !== undefined ? d.autoScale : true,
                    invertScale: d.invertScale || false,
                    scaleMargins: d.scaleMargins || { top: 0.1, bottom: 0.1 },
                };

                // Apply to the specific scale
                chart.priceScale(scaleId).applyOptions(scaleOptions);

                // In Lightweight Charts v5, custom scales need to be explicitly placed in left/right scales array
                if (scaleId !== 'right' && scaleId !== 'left') {
                    // Get current right scales, ensure the new custom scale is in the array
                    const currentRightScales = chart.options().rightPriceScales || [];
                    if (!currentRightScales.includes(scaleId)) {
                        chart.applyOptions({
                            rightPriceScales: [...currentRightScales, scaleId]
                        });
                    }
                }
                break;
            }

            // ─── Chart Options ───────────────────────────────────────────
            case 'set_sync': {
                window.syncEnabled = cmd.data.enabled;
                // enable/disable crosshair sync by toggling the sync manager charts.
                if (!window.syncEnabled) {
                    SyncManager.charts = [];
                    if (SyncManager._rafId) {
                        cancelAnimationFrame(SyncManager._rafId);
                        SyncManager._rafId = null;
                    }
                } else {
                    // Re-register all existing charts
                    window.charts.forEach((chart, id) => {
                        const cell = document.getElementById(id.replace('chart-', 'chart-cell-'));
                        SyncManager.register(chart, cell);
                    });
                }
                break;
            }

            case 'set_crosshair_mode': {
                const chart = window.charts.get(cmd.chartId || 'chart-0');
                if (chart) chart.applyOptions({ crosshair: { mode: cmd.data.mode } });
                break;
            }

            case 'set_timezone':
                window.chartTimeZone = cmd.data.timezone || 'UTC';
                // Reapply localization to all charts
                window.charts.forEach(chart => {
                    chart.applyOptions({
                        localization: {
                            timeFormatter: (ts) => {
                                if (typeof ts !== 'number') return String(ts);
                                return new Date(ts * 1000).toLocaleString('en-GB', {
                                    timeZone: window.chartTimeZone,
                                    day: 'numeric', month: 'short', year: '2-digit',
                                    hour: '2-digit', minute: '2-digit', hour12: false
                                }).replace(',', '');
                            }
                        }
                    });
                });
                break;

            case 'set_timeframe': {
                const el = document.getElementById('active-tf');
                if (el) {
                    el.textContent = cmd.data;
                    el.style.display = 'inline';
                }
                break;
            }

            // ─── Visibility Toggles ───────────────────────────────────────
            case 'hide_loading': {
                const loading = document.getElementById('loading');
                if (loading) {
                    loading.style.opacity = '0';
                    setTimeout(() => loading.style.display = 'none', 500);
                }
                break;
            }

            case 'show_notification':
                showNotification(
                    cmd.data.message,
                    cmd.data.type || 'info',
                    cmd.data.duration || 3000,
                    cmd.data.text_color || null
                );
                break;





            case 'set_layout_toolbar_visibility': {
                const toolbar = document.getElementById('toolbar');
                if (toolbar) toolbar.style.display = cmd.data.visible ? '' : 'none';
                break;
            }





            // ─── Position Tools ───────────────────────────────────────────
            case 'remove_all_positions':
                if (typeof PositionToolManager !== 'undefined') {
                    PositionToolManager.removeAll();
                }
                break;
        } // end switch
    } catch (e) {
        console.error("Command error:", e);
    }
}



// Initial Layout
try {
    createLayout('single');

    // Initialize layout dropdown
    // Initialize layout dropdown
    setupToolbar();
    updateStatus("Loading Data...");
    isReady = true;

    // Notify Backend
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.mark_ready();
    } else {
        window.addEventListener('pywebviewready', () => {
            window.pywebview.api.mark_ready().catch(e => console.log(e));
        });
    }
} catch (e) {
    console.error("Init error:", e);
}

// Legend Helper
function addLegendItem(chartId, id, name, color) {
    const cellId = chartId.replace('chart-', 'chart-cell-');
    const cell = document.getElementById(cellId);
    if (!cell) return;
    const legendContent = cell.querySelector('.chart-legend-content');
    if (!legendContent) return;

    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.seriesId = id;
    item.style.cursor = 'pointer';

    // Add eye icon or just use opacity
    item.innerHTML = `
        <div class="legend-color" style="background:${color}"></div>
        <div class="legend-name">${name}</div>
        <div class="legend-eye" style="margin-left: 6px; font-size: 10px; opacity: 0.7;">👁</div>
    `;

    item.addEventListener('click', () => {
        const series = window.seriesMap.get(id);
        if (series) {
            const opts = series.options();
            const newVisible = !opts.visible;
            series.applyOptions({ visible: newVisible });

            // UI Feedback
            item.style.opacity = newVisible ? '1' : '0.5';
        }
    });

    legendContent.appendChild(item);
}







window.scrollToRealTime = function () {
    window.charts.forEach(chart => {
        chart.timeScale().scrollToRealTime();
    });
}

function setupToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    toolbar.innerHTML = `
        <div class="toolbar-trigger" id="layout-trigger">
            <span>Layout</span>
            <span style="font-size: 8px; opacity: 0.7;">▼</span>
        </div>
        <div class="dropdown-menu" id="layout-menu">
            <div class="menu-item" onclick="changeLayout('single')">
                <div class="layout-preview p-single"><div></div></div>
                Single Chart
            </div>
            <div class="menu-item" onclick="changeLayout('2x1')">
                <div class="layout-preview p-2x1"><div></div><div></div></div>
                2x1 Vertical
            </div>
            <div class="menu-item" onclick="changeLayout('1x2')">
                <div class="layout-preview p-1x2"><div></div><div></div></div>
                1x2 Horizontal
            </div>
            <div class="menu-item" onclick="changeLayout('1p2')">
                <div class="layout-preview p-1p2"><div></div><div></div><div></div></div>
                1 Top + 2 Bottom
            </div>
            <div class="menu-item" onclick="changeLayout('2x2')">
                <div class="layout-preview p-2x2"><div></div><div></div><div></div><div></div></div>
                2x2 Grid
            </div>
        </div>
    `;

    const trigger = document.getElementById('layout-trigger');
    const menu = document.getElementById('layout-menu');

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('visible');
        trigger.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
        if (!toolbar.contains(e.target)) {
            menu.classList.remove('visible');
            trigger.classList.remove('active');
        }
    });

    // Wrap changeLayout to close menu
    if (window.changeLayout) {
        const oldChangeLayout = window.changeLayout;
        window.changeLayout = function (type) {
            oldChangeLayout(type);
            menu.classList.remove('visible');
            trigger.classList.remove('active');
        }
    }
}
