from lwc.chart import Chart
import polars as pl

if __name__ == '__main__':
    chart = Chart()

    layout = chart.set_layout()     ## create layout ie. number of charts

    ch1 = layout[0].create_candlestick_series("Main Chart")

    df = pl.read_csv("data/1d.csv")
    df = df.slice(0, 150)
    df = df.with_columns(pl.col("date").cast(pl.Datetime("ms")))
    ch1.set_data(df)

# Drawing Tools Example utilizing exact times from the dataset for pixel-perfect coordinates.
    # 1. Horizontal Line (PriceLine)
    layout[0].toolbox.create_horizontal_line(series_id=ch1.series_id, price=18.5, color='#F44336', text='Support')
    
    # 2. Box / Rectangle
    layout[0].toolbox.create_box(
        start_time=df['date'][5], 
        end_time=df['date'][15], 
        start_price=19.5, 
        end_price=17.0, 
        color='rgba(255, 255, 0, 0.2)', 
        border_color='#d4af37', 
        text='Consolidation'
    )

    # 3. Ray Line
    layout[0].toolbox.create_ray_line(
        start_time=df['date'][20],
        start_price=20.0,
        end_time=df['date'][30],
        end_price=21.5,
        color='#FF9800',
        text='Uptrend Ray'
    )
    
    # 4. Trendline
    layout[0].toolbox.create_trendline(
        start_time=df['date'][40],
        start_price=20.5,
        end_time=df['date'][55],
        end_price=21.0,
        color='#4CAF50',
        text='Trendline'
    )

    # 5. Fib Retracement
    layout[0].toolbox.create_fib_retracement(
        start_time=df['date'][60],
        start_price=20.19,
        end_time=df['date'][75],
        end_price=17.47,
    )

    '''# 6. Position (Long) widget
    layout[0].toolbox.create_long_position(
        start_time=df['date'][85],
        end_time=df['date'][100],
        entry_price=17.12,
        sl_price=16.08,
        tp_price=19.50,
    )'''
    
    # 7. Position (Short) widget
    layout[0].toolbox.create_short_position(
        start_time=df['date'][110],
        end_time=df['date'][125],
        entry_price=17.96,
        sl_price=18.8,
        tp_price=16.15,
    )
    
    # 8. Marker
    layout[0].toolbox.add_marker(
        series_id=ch1.series_id,
        time=df['date'][140],
        position='belowBar',
        color='#E91E63',
        shape='arrowUp',
        text='Buy Signal'
    )

    chart.show(block=True)
