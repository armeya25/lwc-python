from lwc.chart import Chart
import polars as pl

if __name__ == '__main__':
    chart = Chart()
    
    chart.set_sync(False)   ## disable sync of charts

    layout = chart.set_layout("2x1")     ## create layout ie. number of charts

    ch1 = layout[0].create_candlestick_series("chart1")
    ch2 = layout[1].create_candlestick_series("chart2")

    df = pl.read_csv("data/1d.csv")
    df = df.slice(-100)
    ch1.set_data(df)

    df = pl.read_csv("data/5m.csv")
    df = df.slice(-100)
    ch2.set_data(df)
    
    chart.show(block=True)