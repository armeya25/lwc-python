/* Marker Manager */
// console.log("Plugins loading...");
const MarkerManager = {
    _markers: new Map(), // seriesId -> Map<markerId, markerData>
    _primitives: new Map(), // seriesId -> markersPrimitive

    addMarker: function (seriesId, markerData) {
        if (!this._markers.has(seriesId)) {
            this._markers.set(seriesId, new Map());
        }
        const seriesMarkers = this._markers.get(seriesId);
        seriesMarkers.set(markerData.id, markerData);
        this.applyMarkers(seriesId);
    },

    removeMarker: function (seriesId, markerId) {
        if (this._markers.has(seriesId)) {
            const seriesMarkers = this._markers.get(seriesId);
            if (seriesMarkers.delete(markerId)) {
                this.applyMarkers(seriesId);
            }
        }
    },

    updateMarker: function (seriesId, markerId, changes) {
        if (this._markers.has(seriesId)) {
            const seriesMarkers = this._markers.get(seriesId);
            const marker = seriesMarkers.get(markerId);
            if (marker) {
                Object.assign(marker, changes);
                seriesMarkers.set(markerId, marker);
                this.applyMarkers(seriesId);
            }
        }
    },

    applyMarkers: function (seriesId) {
        const series = window.seriesMap.get(seriesId);
        if (series) {
            if (!this._markers.has(seriesId)) {
                this._markers.set(seriesId, new Map());
            }
            const seriesMarkers = this._markers.get(seriesId);
            const markersArray = Array.from(seriesMarkers.values()).sort((a, b) => {
                return a.time > b.time ? 1 : -1;
            });

            // Detach old primitive if exists to prevent duplicates/stale state
            let oldPrimitive = this._primitives.get(seriesId);
            if (oldPrimitive) {
                try {
                    if (series.detachPrimitive) series.detachPrimitive(oldPrimitive);
                    else if (series.removePrimitive) series.removePrimitive(oldPrimitive);
                } catch (e) { console.log(e); }
            }

            if (typeof LightweightCharts.createSeriesMarkers === 'function') {
                // Create and attach new primitive with data
                let primitive = LightweightCharts.createSeriesMarkers(series, markersArray);
                this._primitives.set(seriesId, primitive);
            } else if (typeof series.setMarkers === 'function') {
                series.setMarkers(markersArray);
            } else {
                console.error("MarkerManager: No valid API to set markers!");
            }

        } else {
            console.warn("MarkerManager.applyMarkers: Series not found:", seriesId);
        }
    }
};

/* Price Line Manager */
const PriceLineManager = {
    _lines: new Map(), // lineId -> { seriesId, lineObj }

    create: function (seriesId, lineId, options) {
        const series = window.seriesMap.get(seriesId);
        if (series) {
            const lineObj = series.createPriceLine(options);
            this._lines.set(lineId, { seriesId, lineObj });
        }
    },

    remove: function (lineId) {
        const record = this._lines.get(lineId);
        if (record) {
            const series = window.seriesMap.get(record.seriesId);
            if (series) {
                series.removePriceLine(record.lineObj);
            }
            this._lines.delete(lineId);
        }
    },

    update: function (lineId, options) {
        const record = this._lines.get(lineId);
        if (record) {
            record.lineObj.applyOptions(options);
        }
    }
};

/* Box/Rectangle Overlay Manager */
const BoxManager = {
    _boxes: new Map(),
    _rafId: null,
    _containers: new Map(), // chartId -> container
    _dirtyCharts: new Set(),

    init: function (chartId, chartElement) {
        // Create an overlay layer on top of the chart cell
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.pointerEvents = 'none'; // click-through
        container.style.zIndex = '100';

        if (chartElement.firstChild) {
            chartElement.insertBefore(container, chartElement.firstChild);
        } else {
            chartElement.appendChild(container);
        }

        this._containers.set(chartId, container);

        // Subscribe to chart updates to redraw
        const chart = window.charts.get(chartId);
        if (chart) {
            chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.updatePositions(chartId));
            chart.timeScale().subscribeSizeChange(() => this.updatePositions(chartId));
            // Hook into crosshair move to catch Price Scale interactions (Y-axis zoom/scroll)
            chart.subscribeCrosshairMove(() => this.updatePositions(chartId));
        }

        // Add native DOM listeners for pinch/zoom interactions that might bypass LWC events
        // Use 'passive: true' to not block scrolling performance
        chartElement.addEventListener('wheel', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchmove', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchstart', () => this.updatePositions(chartId), { passive: true });
    },

    createBox: function (chartId, id, data) {
        const container = this._containers.get(chartId);
        if (!container) return; // Chart not initialized or invalid ID

        const div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.backgroundColor = data.color;
        div.style.backdropFilter = 'blur(4px)';
        div.style.webkitBackdropFilter = 'blur(4px)';

        // Border Logic
        const width = data.border_width !== undefined ? data.border_width : 1;
        const style = data.border_style || 'solid';
        div.style.border = `${width}px ${style} ${data.border_color || data.color}`;
        div.style.opacity = '0.8';
        div.style.boxSizing = 'border-box';
        div.style.display = data.visible === false ? 'none' : 'block';
        div.id = `box-${id}`;
        div.classList.add('gpu-layer');

        if (data.text) {
            div.innerText = data.text;
            div.style.color = data.text_color || '#ffffff';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.fontSize = '12px';
            div.style.overflow = 'hidden';
            div.style.whiteSpace = 'nowrap';
        }

        container.appendChild(div);

        const box = {
            id: id,
            chartId: chartId,
            data: data,
            element: div
        };
        this._boxes.set(id, box);
        this.updateBoxPosition(box);
    },

    // ... removeBox, updateBox remain mostly same, just fetching by ID ...
    removeBox: function (id) {
        const box = this._boxes.get(id);
        if (box) {
            if (box.element.parentNode) box.element.parentNode.removeChild(box.element);
            this._boxes.delete(id);
        }
    },

    updateBox: function (id, partialData) {
        const box = this._boxes.get(id);
        if (box) {
            Object.assign(box.data, partialData);
            // ... (style updates same as before) ...
            if (partialData.color) box.element.style.backgroundColor = partialData.color;
            if (partialData.border_color || partialData.border_width !== undefined || partialData.border_style) {
                const width = box.data.border_width !== undefined ? box.data.border_width : 1;
                const style = box.data.border_style || 'solid';
                const color = box.data.border_color || box.data.color;
                box.element.style.border = `${width}px ${style} ${color}`;
            }
            if (partialData.visible !== undefined) box.element.style.display = partialData.visible ? 'block' : 'none';
            if (partialData.text !== undefined) {
                box.element.innerText = partialData.text;
                if (partialData.text) {
                    box.element.style.display = (box.data.visible !== false) ? 'flex' : 'none';
                    box.element.style.alignItems = 'center';
                    box.element.style.justifyContent = 'center';
                }
            }
            if (partialData.text_color) box.element.style.color = partialData.text_color;

            this.updateBoxPosition(box);
        }
    },

    updatePositions: function (specificChartId) {
        if (specificChartId) this._dirtyCharts.add(specificChartId);

        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._boxes.forEach(box => {
                if (this._dirtyCharts.size === 0 || this._dirtyCharts.has(box.chartId)) {
                    this.updateBoxPosition(box);
                }
            });
            this._dirtyCharts.clear();
            this._rafId = null;
        });
    },

    updateBoxPosition: function (box) {
        const chart = window.charts.get(box.chartId);
        if (!chart) return;

        const series = window.getSeriesForChart(box.chartId);
        if (!series) return;

        const timeScale = chart.timeScale();
        const container = this._containers.get(box.chartId);
        const data = box.data;

        // Helper: resolve time coordinate even when time is off-screen.
        // timeToCoordinate() returns null for out-of-range times, which would
        // cause boxes to be hidden even when they partially span the visible area.
        // Instead, clamp offscreen-left to -9999 and offscreen-right to container width + 9999.
        const getX = (t) => {
            if (t == null) return null;
            const coord = timeScale.timeToCoordinate(t);
            if (coord !== null) return coord;
            // Project based on visible range
            const range = timeScale.getVisibleRange();
            if (range) {
                if (t < range.from) return -9999;
                if (t > range.to) return (container ? container.clientWidth : 0) + 9999;
            }
            return null;
        };

        const x1 = getX(data.start_time);
        const x2 = getX(data.end_time);

        // Prices
        const p1 = data.top_price !== undefined ? data.top_price : data.start_price;
        const p2 = data.bottom_price !== undefined ? data.bottom_price : data.end_price;
        const y1 = series.priceToCoordinate(p1);
        const y2 = series.priceToCoordinate(p2);

        // Only hide if both time coordinates are completely unresolvable, or price is off scale
        if (x1 === null || y1 === null) {
            box.element.style.display = 'none';
            return;
        }

        // Ensure visible if it was hidden
        if (box.data.visible !== false) box.element.style.display = 'block';

        // Coordinates — x2 null means infinite/future: extend to right edge
        const resolvedX2 = x2 !== null ? x2 : (container ? container.clientWidth + 9999 : 9999);
        const resolvedY2 = y2 !== null ? y2 : y1; // fallback if bottom price off scale

        const left = Math.min(x1, resolvedX2);
        const width = Math.abs(resolvedX2 - x1);
        const top = Math.min(y1, resolvedY2);
        const height = Math.abs(resolvedY2 - y1);

        box.element.style.left = `${left}px`;
        box.element.style.top = `${top}px`;
        box.element.style.width = `${width}px`;
        box.element.style.height = `${height}px`;
    }
    // ...
};

// ... Similar updates for PositionToolManager ...
// Due to complexity, I will keep previous simple logic but adapted for 'chart-0' primarily 
// satisfying the 'app.js' refactor, and full-on multi-series support is a later step.
// I will just make sure it doesn't crash app.js.

const PositionToolManager = {
    _positions: new Map(),
    _rafId: null,
    _containers: new Map(),
    _dirtyCharts: new Set(),

    init: function (chartId, chartElement) {
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '101'; // Above boxes

        if (chartElement.firstChild) {
            chartElement.insertBefore(container, chartElement.firstChild);
        } else {
            chartElement.appendChild(container);
        }

        this._containers.set(chartId, container);

        const chart = window.charts.get(chartId);
        if (chart) {
            chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.updatePositions(chartId));
            chart.timeScale().subscribeSizeChange(() => this.updatePositions(chartId));
            chart.subscribeCrosshairMove(() => this.updatePositions(chartId));
        }

        chartElement.addEventListener('wheel', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchmove', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchstart', () => this.updatePositions(chartId), { passive: true });
    },

    create: function (chartId, id, data) {
        if (this._positions.has(id)) return;

        const container = this._containers.get(chartId);
        if (!container) return;

        data.quantity = data.quantity || 1; // Default quantity

        // Container
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.display = data.visible === false ? 'none' : 'block';
        el.id = `pos-${id}`;
        el.classList.add('gpu-layer');

        // Profit Zone
        const profitDiv = document.createElement('div');
        profitDiv.style.position = 'absolute';
        profitDiv.style.background = 'linear-gradient(180deg, rgba(76, 175, 80, 0.4) 0%, rgba(76, 175, 80, 0.1) 100%)';
        profitDiv.style.border = '1px solid rgba(76, 175, 80, 0.8)';
        profitDiv.style.boxSizing = 'border-box';
        profitDiv.style.borderRadius = '4px';
        profitDiv.innerHTML = '<span style="color:#ffffff; font-weight:bold; font-family:sans-serif; font-size:10px; padding:2px 4px; background:rgba(76, 175, 80, 1); border-radius:0 0 4px 0;">TP</span>';

        // Loss Zone
        const lossDiv = document.createElement('div');
        lossDiv.style.position = 'absolute';
        lossDiv.style.background = 'linear-gradient(180deg, rgba(244, 67, 54, 0.1) 0%, rgba(244, 67, 54, 0.4) 100%)';
        lossDiv.style.border = '1px solid rgba(244, 67, 54, 0.8)';
        lossDiv.style.boxSizing = 'border-box';
        lossDiv.style.borderRadius = '4px';
        lossDiv.innerHTML = '<span style="color:#ffffff; font-weight:bold; font-family:sans-serif; font-size:10px; padding:2px 4px; background:rgba(244, 67, 54, 1); border-radius:0 0 4px 0;">SL</span>';

        // Entry Line
        const entryDiv = document.createElement('div');
        entryDiv.style.position = 'absolute';
        entryDiv.style.height = '1px';
        entryDiv.style.backgroundColor = '#B0BEC5';
        entryDiv.style.borderTop = '1px dashed #ffffff';
        entryDiv.style.opacity = '0.8';

        // Stats Box (Consolidated)
        const statsDiv = document.createElement('div');
        statsDiv.style.position = 'absolute';
        statsDiv.style.color = '#ffffff';
        statsDiv.style.fontFamily = "'Inter', sans-serif";
        statsDiv.style.fontSize = '11px';
        statsDiv.style.background = 'rgba(30, 30, 30, 0.85)'; // Slightly more opaque
        statsDiv.style.backdropFilter = 'blur(6px)';
        statsDiv.style.webkitBackdropFilter = 'blur(6px)';
        statsDiv.style.padding = '8px'; // More padding
        statsDiv.style.borderRadius = '6px';
        statsDiv.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        statsDiv.style.whiteSpace = 'nowrap';
        statsDiv.style.pointerEvents = 'none';
        statsDiv.style.boxShadow = '0 4px 10px rgba(0,0,0,0.4)';
        statsDiv.style.display = 'flex';
        statsDiv.style.flexDirection = 'column';
        statsDiv.style.gap = '3px';
        statsDiv.style.zIndex = '20'; // Higher z-index
        statsDiv.style.minWidth = '120px';

        el.appendChild(profitDiv);
        el.appendChild(lossDiv);
        el.appendChild(entryDiv);
        el.appendChild(statsDiv);

        container.appendChild(el);

        const position = {
            id: id,
            chartId: chartId,
            data: data,
            element: el,
            profitEl: profitDiv,
            lossEl: lossDiv,
            entryEl: entryDiv,
            statsEl: statsDiv
        };

        this._positions.set(id, position);
        this.updatePosition(position);
    },

    remove: function (id) {
        const pos = this._positions.get(id);
        if (pos) {
            if (pos.element.parentNode) {
                pos.element.parentNode.removeChild(pos.element);
            }
            this._positions.delete(id);
        }
    },

    removeAll: function () {
        this._positions.forEach(pos => {
            if (pos.element.parentNode) {
                pos.element.parentNode.removeChild(pos.element);
            }
        });
        this._positions.clear();
    },

    update: function (id, partialData) {
        const pos = this._positions.get(id);
        if (pos) {
            Object.assign(pos.data, partialData);
            if (partialData.visible !== undefined) {
                pos.element.style.display = partialData.visible ? 'block' : 'none';
            }
            this.updatePosition(pos);
        }
    },

    updatePositions: function (specificChartId) {
        if (specificChartId) this._dirtyCharts.add(specificChartId);

        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._positions.forEach(pos => {
                if (this._dirtyCharts.size === 0 || this._dirtyCharts.has(pos.chartId)) {
                    this.updatePosition(pos);
                }
            });
            this._dirtyCharts.clear();
            this._rafId = null;
        });
    },

    updatePosition: function (pos) {
        const chart = window.charts.get(pos.chartId);
        if (!chart) return;

        const series = window.getSeriesForChart(pos.chartId);
        if (!series) return;

        const timeScale = chart.timeScale();
        const data = pos.data;
        const container = this._containers.get(pos.chartId);
        const containerW = container ? container.clientWidth : 2000;

        // start_time: clamp to 0 if before visible range, null if after (future, hide)
        let x1 = null;
        if (data.start_time != null) {
            const c = timeScale.timeToCoordinate(data.start_time);
            if (c !== null) {
                x1 = c;
            } else {
                const range = timeScale.getVisibleRange();
                if (range && data.start_time < range.from) x1 = 0; // clip to left edge
                // else start_time is in the future → keep null → hide
            }
        }
        // end_time: clamp to containerW if off-screen-right or no end_time
        let x2 = containerW;
        if (data.end_time != null) {
            const c = timeScale.timeToCoordinate(data.end_time);
            x2 = c !== null ? c : containerW;
        }

        // Prices
        const yEntry = series.priceToCoordinate(data.entry_price);
        const ySL = series.priceToCoordinate(data.sl_price);
        const yTP = series.priceToCoordinate(data.tp_price);

        if (x1 === null || yEntry === null || ySL === null || yTP === null) {
            pos.element.style.display = 'none';
            return;
        }

        if (data.visible === false) {
            pos.element.style.display = 'none';
            return;
        }
        pos.element.style.display = 'block';

        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);

        const yProfitTop = Math.min(yTP, yEntry);
        const hProfit = Math.abs(yTP - yEntry);
        const yLossTop = Math.min(ySL, yEntry);
        const hLoss = Math.abs(ySL - yEntry);

        // Apply Styles
        pos.profitEl.style.left = left + 'px';
        pos.profitEl.style.width = width + 'px';
        pos.profitEl.style.top = yProfitTop + 'px';
        pos.profitEl.style.height = hProfit + 'px';

        pos.lossEl.style.left = left + 'px';
        pos.lossEl.style.width = width + 'px';
        pos.lossEl.style.top = yLossTop + 'px';
        pos.lossEl.style.height = hLoss + 'px';

        pos.entryEl.style.left = left + 'px';
        pos.entryEl.style.width = width + 'px';
        pos.entryEl.style.top = (yEntry) + 'px';

        // Stats Box Content
        const risk = Math.abs(data.entry_price - data.sl_price);
        const reward = Math.abs(data.tp_price - data.entry_price);
        const rr = risk !== 0 ? (reward / risk).toFixed(2) : '∞';

        const qty = data.quantity || 1;
        const pnl = (data.type === 'long' ? (data.tp_price - data.entry_price) : (data.entry_price - data.tp_price)) * qty;
        const riskAmt = risk * qty;

        const typeStr = data.type === 'long' ? 'LONG' : 'SHORT';
        const typeColor = data.type === 'long' ? '#4CAF50' : '#F44336';

        pos.statsEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; margin-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:2px">
                <span style="color:${typeColor}; font-weight:bold">${typeStr}</span>
                <span style="color:#aaa">Qty: ${qty}</span>
            </div>
            
            <div style="display:grid; grid-template-columns: auto auto; gap: 2px 10px;">
                <span style="color:#ccc">Entry:</span> <span style="text-align:right">${data.entry_price.toFixed(2)}</span>
                <span style="color:#4CAF50">TP:</span> <span style="text-align:right">${data.tp_price.toFixed(2)}</span>
                <span style="color:#EF5350">SL:</span> <span style="text-align:right">${data.sl_price.toFixed(2)}</span>
            </div>
            
            <div style="margin-top:4px; padding-top:2px; border-top:1px solid rgba(255,255,255,0.1); display:grid; grid-template-columns: auto auto; gap: 2px 10px;">
                <span style="color:#ccc">Ratio:</span> <span style="text-align:right; font-weight:bold">${rr}</span>
                <span style="color:#4CAF50">Reward:</span> <span style="text-align:right">$${pnl.toFixed(2)}</span>
                <span style="color:#EF5350">Risk:</span> <span style="text-align:right">$${riskAmt.toFixed(2)}</span>
            </div>
        `;

        // pos.statsEl.style.left = (left + width + 8) + 'px'; // 8px padding (OLD: Right side)

        // NEW: Left side
        // We need to calculate left position based on stats width, but stats width is dynamic.
        // So we use transform: translateX(-100%) and set left to (left - 8)
        pos.statsEl.style.left = (left - 8) + 'px';

        const distinctY = [yEntry, yTP, ySL];
        const minY = Math.min(...distinctY);
        const maxY = Math.max(...distinctY);
        const centerY = (minY + maxY) / 2;
        pos.statsEl.style.top = centerY + 'px';
        // Translate -100% in X to move it to the left of the reference point, and -50% in Y to center vertically
        pos.statsEl.style.transform = 'translate(-100%, -50%)';
    }
}

// ... PositionToolManager ...

const LineToolManager = {
    _tools: new Map(), // id -> toolData
    _rafId: null,
    _containers: new Map(), // chartId -> svgContainer
    _dirtyCharts: new Set(),

    init: function (chartId, chartElement) {
        // Create SVG container
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '102'; // Above boxes and positions?

        if (chartElement.firstChild) {
            chartElement.insertBefore(svg, chartElement.firstChild);
        } else {
            chartElement.appendChild(svg);
        }

        this._containers.set(chartId, svg);

        const chart = window.charts.get(chartId);
        if (chart) {
            chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.updatePositions(chartId));
            chart.timeScale().subscribeSizeChange(() => this.updatePositions(chartId));
            chart.subscribeCrosshairMove(() => this.updatePositions(chartId));
        }

        chartElement.addEventListener('wheel', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchmove', () => this.updatePositions(chartId), { passive: true });
        chartElement.addEventListener('touchstart', () => this.updatePositions(chartId), { passive: true });
    },

    create: function (chartId, id, data) {
        const svg = this._containers.get(chartId);
        if (!svg) return;

        // Group element for the tool
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.id = `line-${id}`;
        // g.classList.add('gpu-layer'); // Removed: CSS 3D transforms break SVG rendering often
        g.style.display = data.visible === false ? 'none' : 'block';
        svg.appendChild(g);

        const tool = {
            id: id,
            chartId: chartId,
            data: data,
            element: g
        };
        this._tools.set(id, tool);
        this.updateTool(tool);
    },

    remove: function (id) {
        const tool = this._tools.get(id);
        if (tool) {
            if (tool.element.parentNode) tool.element.parentNode.removeChild(tool.element);
            this._tools.delete(id);
        }
    },

    update: function (id, partialData) {
        const tool = this._tools.get(id);
        if (tool) {
            Object.assign(tool.data, partialData);
            if (partialData.visible !== undefined) {
                tool.element.style.display = partialData.visible ? 'block' : 'none';
            }
            this.updateTool(tool);
        }
    },

    updatePositions: function (specificChartId) {
        if (specificChartId) this._dirtyCharts.add(specificChartId);

        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._tools.forEach(tool => {
                if (this._dirtyCharts.size === 0 || this._dirtyCharts.has(tool.chartId)) {
                    this.updateTool(tool);
                }
            });
            this._dirtyCharts.clear();
            this._rafId = null;
        });
    },

    updateTool: function (tool) {
        const chart = window.charts.get(tool.chartId);
        if (!chart) return;
        const series = window.getSeriesForChart(tool.chartId);
        if (!series) return;

        const timeScale = chart.timeScale();
        const data = tool.data;
        const g = tool.element;



        // Clear existing SVG content
        while (g.firstChild) {
            g.removeChild(g.firstChild);
        }

        const container = this._containers.get(tool.chartId);
        const w = container ? container.clientWidth : 2000;

        // Helper to get X coordinate even if off-screen
        const getX = (t) => {
            const coord = timeScale.timeToCoordinate(t);
            if (coord !== null) return coord;

            // Fallback: Use visible range to project off-screen
            const range = timeScale.getVisibleRange();
            if (range) {
                if (t < range.from) return -5000;
                if (t > range.to) return w + 5000;
            }
            return null;
        };

        const x1 = getX(data.start_time);
        const y1 = series.priceToCoordinate(data.start_price);
        const x2 = getX(data.end_time);
        const y2 = series.priceToCoordinate(data.end_price);

        if (x1 === null || y1 === null) {
            // Only abort if we strictly can't calculate coordinates (e.g. data missing)
            // If x2/y2 is missing (incomplete tool), we might still want to handle it?
            // For now, strict check on Point 1 is okay, but we fixed the 'off-screen' null issue.
            while (g.firstChild) { g.removeChild(g.firstChild); }
            return;
        }

        const color = data.color || '#2196F3';
        const width = data.width || 2;
        // SVG dasharray: 1 = "5,5" (Dashed), 2 = "2,2" (Dotted)
        let dash = '';
        if (data.style === 1) dash = '5,5';
        if (data.style === 2) dash = '2,2';

        if (data.type === 'trendline') {
            if (x2 !== null && y2 !== null) {
                // Main Line with Glow
                this.drawSvgLine(g, x1, y1, x2, y2, color, width, dash, true);

                // Label
                if (data.text) {
                    this.drawTextLabel(g, x1, y1, x2, y2, data.text, color);
                }
            }
        } else if (data.type === 'ray') {
            if (x2 !== null && y2 !== null) {
                // Calculate slope and extend
                const container = this._containers.get(tool.chartId);
                const w = container.clientWidth;
                const h = container.clientHeight;

                const dx = x2 - x1;
                const dy = y2 - y1;

                if (dx === 0 && dy === 0) return;

                const factor = 10000;
                const extX = x1 + dx * factor;
                const extY = y1 + dy * factor;

                this.drawSvgLine(g, x1, y1, extX, extY, color, width, dash, true);

                // Label (placed near start)
                if (data.text) {
                    // For Ray, place label along the path near P1-P2 segment
                    this.drawTextLabel(g, x1, y1, x2, y2, data.text, color);
                }
            }
        } else if (data.type === 'fib') {
            if (x2 !== null && y2 !== null) {
                // Fib Levels
                const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
                const colors = [
                    'rgba(244, 67, 54, 0.15)', // 0-0.236 (Red)
                    'rgba(255, 152, 0, 0.15)', // 0.236-0.382 (Orange)
                    'rgba(255, 235, 59, 0.15)', // 0.382-0.5 (Yellow)
                    'rgba(205, 220, 57, 0.15)', // 0.5-0.618 (Lime)
                    'rgba(76, 175, 80, 0.15)',  // 0.618-0.786 (Green)
                    'rgba(0, 150, 136, 0.15)'   // 0.786-1 (Teal)
                ];

                const container = this._containers.get(tool.chartId);
                const w = container.clientWidth;

                let leftX = Math.min(x1, x2);
                let rightX = Math.max(x1, x2);

                // Infinite Extension
                if (data.extended) {
                    rightX = w; // Extend to right edge
                }

                const width = rightX - leftX;

                // 1. Draw Fills (Bottom Layer)
                for (let i = 0; i < levels.length - 1; i++) {
                    const levelTop = levels[i];
                    const levelBottom = levels[i + 1];
                    const yTop = y1 + (y2 - y1) * levelTop;
                    const yBottom = y1 + (y2 - y1) * levelBottom;

                    const rectTop = Math.min(yTop, yBottom);
                    const rectHeight = Math.abs(yBottom - yTop);

                    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                    rect.setAttribute("x", leftX);
                    rect.setAttribute("y", rectTop);
                    rect.setAttribute("width", width);
                    rect.setAttribute("height", rectHeight);
                    rect.setAttribute("fill", colors[i] || 'rgba(255,255,255,0.05)');
                    rect.setAttribute("stroke", "none");
                    g.appendChild(rect);
                }

                // 2. Draw Lines & Labels (Top Layer)
                levels.forEach(level => {
                    const levelY = y1 + (y2 - y1) * level;
                    const lineColor = (level === 0 || level === 1) ? color : 'rgba(255,255,255,0.4)';

                    this.drawSvgLine(g, leftX, levelY, rightX, levelY, lineColor, 1, dash);

                    // Label
                    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                    text.setAttribute("x", leftX + 4);
                    text.setAttribute("y", levelY - 4);
                    text.setAttribute("fill", lineColor);
                    text.setAttribute("font-size", "10");
                    text.setAttribute("font-family", "sans-serif");
                    text.textContent = `${level} (${(data.start_price + (data.end_price - data.start_price) * level).toFixed(2)})`;
                    g.appendChild(text);
                });

                // Connect diagonal P1 to P2 (Only if not extended, or just P1 to original P2)
                // this.drawSvgLine(g, x1, y1, x2, y2, 'rgba(255,255,255,0.2)', 1, '2,2');
            }
        }
    },

    drawSvgLine: function (g, x1, y1, x2, y2, color, width, dash, glow = false) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", width);
        if (dash) line.setAttribute("stroke-dasharray", dash);
        if (glow) {
            line.style.filter = `drop-shadow(0 0 3px ${color})`;
        }
        g.appendChild(line);
    },

    drawTextLabel: function (g, x1, y1, x2, y2, text, color) {
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

        // Ensure text is readable (not upside down)
        let rotation = angle;
        if (rotation > 90 || rotation < -90) {
            rotation += 180;
        }

        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", midX);
        t.setAttribute("y", midY - 6); // Offset slightly above
        t.setAttribute("fill", color);
        t.setAttribute("font-size", "11");
        t.setAttribute("font-family", "sans-serif");
        t.setAttribute("font-weight", "bold");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("transform", `rotate(${rotation}, ${midX}, ${midY})`);
        t.style.textShadow = '0 0 2px rgba(0,0,0,0.8)'; // Outline shadow for readability
        t.textContent = text;
        g.appendChild(t);
    }
};

window.BoxManager = BoxManager;
window.PositionToolManager = PositionToolManager;
window.LineToolManager = LineToolManager;
