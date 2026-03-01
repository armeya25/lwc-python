from lwc.chart import Chart
import polars as pl

def SMA(df):
    df = df.with_columns(
        pl.col("close").rolling_mean(window_size=14).alias("sma")
    )
    return df

def RSI(df, period=14):
    df = df.with_columns(
        (pl.col("close") - pl.col("close").shift(1)).alias("delta")
    )
    df = df.with_columns(
        pl.when(pl.col("delta") > 0).then(pl.col("delta")).otherwise(0).alias("gain"),
        pl.when(pl.col("delta") < 0).then(-pl.col("delta")).otherwise(0).alias("loss")
    )
    df = df.with_columns(
        pl.col("gain").ewm_mean(alpha=1/period, ignore_nulls=True).alias("avg_gain"),
        pl.col("loss").ewm_mean(alpha=1/period, ignore_nulls=True).alias("avg_loss")
    )
    df = df.with_columns(
        (100 - (100 / (1 + pl.col("avg_gain") / pl.col("avg_loss")))).alias("rsi")
    )
    return df

if __name__ == '__main__':
    chart = Chart()

    layout = chart.set_layout()     ## create layout ie. number of charts

    ch1 = layout[0].create_candlestick_series("testing")

    df = pl.read_csv("data/1d.csv")
    df = df.slice(-100)
    ch1.set_data(df)

    ### select date and close column
    sma = SMA(df.select(["date", "close"]))
    ## create sma line
    sma_line = layout[0].create_line_series("SMA 14", color="orange", width=2)
    
    # Extract just date and sma for the line series
    sma_data = sma.select([
        pl.col("date").alias("time"),
        pl.col("sma").alias("value")
    ])
    ## set data to sma line
    sma_line.set_data(sma_data)
    
    ### select date and close column
    rsi_df = RSI(df.select(["date", "close"]))
    ## create RSI pane
    rsi_pane = layout[0].create_pane("RSI 14", color="purple", height_ratio=0.3)

    # Extract just date and rsi
    rsi_data = rsi_df.select([
        pl.col("date").alias("time"),
        pl.col("rsi").alias("value")
    ])
    ## set data to rsi pane
    rsi_pane.set_data(rsi_data)
    
    chart.show(block=True)