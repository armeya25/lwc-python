import time
from lwc.chart import Chart
import polars as pl

if __name__ == '__main__':
    chart = Chart()

    layout = chart.set_layout()     ## create layout ie. number of charts

    ch1 = layout[0].create_candlestick_series("testing")

    df_full = pl.read_csv("data/1d.csv")
    df_initial = df_full.slice(0, 100)
    ch1.set_data(df_initial)

    chart.show(block=False)
    
    df_stream = df_full.slice(100, 200)
    for f in df_stream.iter_slices(1):
        if not chart.is_alive():
            break
        ch1.update(f)
        time.sleep(0.1) # Add a small delay to see the update visually
        