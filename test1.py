from lwc.chart import Chart
import polars as pl

if __name__ == '__main__':
    chart = Chart()

    layout = chart.set_layout()     ## create layout ie. number of charts

    ch1 = layout[0].create_candlestick_series("testing")

    df = pl.read_csv("1d.csv")
    df = df.slice(-100)
    ch1.set_data(df)
    
    chart.show(block=True)