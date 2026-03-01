## if on i3/swaywm windows manager
export WEBKIT_DISABLE_COMPOSITING_MODE="1"
add this to .bashrc file

## notes
some examples in [examples/](examples/)
you cant directly run those examples from that directory.
you need to move it to the main directory and run it from there.

# lwc-python

`lwc-python` is a Python charting library that provides a high-performance, interactive, and beautifully styled charting interface by bridging Python and TradingView's [Lightweight Charts](https://github.com/tradingview/lightweight-charts) via `pywebview`.

## Features
- **High Performance:** Uses `polars` for fast data processing and `multiprocessing` to run the GUI in a separate process, preventing the main Python thread from blocking.
- **Interactive UI:** Supports crosshair synchronization, custom grid layouts (e.g., single, 2x1, 1x2, 2x2), and interactive floating tooltips.
- **Auto Volume Histograms:** Automatically adds a colored volume histogram if the provided DataFrame contains a `volume` column.
- **Drawing Tools:** Includes tools for adding lines, markers, boxes, and position widgets directly from Python.

## Example Usage

```python
from lwc.chart import Chart
import polars as pl

if __name__ == '__main__':
    chart = Chart()

    # Create layout and get chart instances
    layout = chart.set_layout('single')
    
    # Create a candlestick series
    ch1 = layout[0].create_candlestick_series("Main Chart")

    # Load data into a Polars DataFrame
    df = pl.read_csv("1d.csv")
    
    # Set data (auto-detects 'volume' column and adds histogram)
    ch1.set_data(df)
    
    # Show the chart blocking
    chart.show(block=True)
```

## Project Structure
- `lwc/`: The Python backend wrapper logic.
- `frontend/lwc/`: The web interface containing HTML, CSS, and JS logic tying the `Lightweight Charts` library to the python backend.
