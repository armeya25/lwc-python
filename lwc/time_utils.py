
import json
from datetime import datetime, date, timezone
import polars as pl

def ensure_timestamp(val):
    """
    Ensure the value is a Unix timestamp in seconds.
    Handles datetime/date objects (assuming UTC for naive inputs to match Polars).
    Returns seconds to match Lightweight Charts expectations.
    """
    if val is None:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            val = val.replace(tzinfo=timezone.utc)
        return val.timestamp()
    if isinstance(val, date):
         # Convert date to datetime at midnight UTC
         val = datetime.combine(val, datetime.min.time()).replace(tzinfo=timezone.utc)
         return val.timestamp()

    if isinstance(val, str):
        try:
            dt = datetime.strptime(val, "%Y-%m-%d %H:%M:%S")
            return dt.replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            try:
                dt = datetime.strptime(val, "%Y-%m-%d")
                return dt.replace(tzinfo=timezone.utc).timestamp()
            except ValueError:
                pass
    # If already a number, assume it's in seconds
    if isinstance(val, (int, float)):
        return val
    return val

def timestamp_to_date_str(val):
    """
    Convert a value to a YYYY-MM-DD date string in UTC.
    Accepts datetime/date objects, strings, or numeric timestamps (seconds).
    Routes through ensure_timestamp first for uniform handling.
    """
    if hasattr(val, 'strftime'):
        return val.strftime("%Y-%m-%d")
    ts = ensure_timestamp(val)
    if ts is not None:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    return str(val)

def process_polars_data(df: pl.DataFrame) -> pl.DataFrame:
    """
    Internal helper to automatically process Polars DataFrames:
    1. Identifies 'date' column.
    2. Converts 'date' to 'time' (Unix seconds).
    3. Ensures 'time' column exists.
    """
    if "date" in df.columns:
        # Cast to Datetime (s) to normalize, then to Int64 for Unix seconds.
        # Polars' cast to Int64 from Datetime assumes UTC if no timezone is set.
        # This matches Python's .replace(tzinfo=timezone.utc).timestamp()
        try:
            df = df.with_columns(
               (pl.col("date").cast(pl.Datetime("ms")).cast(pl.Int64) // 1000).alias("time")
            ).drop("date")
        except Exception as e:
            print(f"Warning: Failed to auto-convert 'date' column: {e}")
    return df

class DateTimeEncoder(json.JSONEncoder):
    """
    Custom JSON encoder to handle datetime and date objects.
    Enforces UTC for naive datetimes to match Polars/Drawings logic.
    Returns Unix seconds to match Lightweight Charts expectations.
    """
    def default(self, obj):
        if isinstance(obj, datetime):
            if obj.tzinfo is None:
                obj = obj.replace(tzinfo=timezone.utc)
            return obj.timestamp()
        if isinstance(obj, date):
            # Midnight UTC
            obj = datetime.combine(obj, datetime.min.time()).replace(tzinfo=timezone.utc)
            return obj.timestamp()
        return super().default(obj)

