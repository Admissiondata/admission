import pandas as pd
from io import BytesIO
from typing import Dict, List, Tuple


def normalize_text(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip().lower()


def normalize_number(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def process_datasets(left_df: pd.DataFrame, right_df: pd.DataFrame) -> Dict[str, List[Dict[str, object]]]:
    left_df = left_df.copy()
    right_df = right_df.copy()

    for df in (left_df, right_df):
        df["_name_key"] = df["Name"].apply(normalize_text)
        df["_acpc_key"] = df["ACPC Application Number"].apply(normalize_number)
        df["_fee_key"] = df["Fees"].fillna("").astype(str).str.strip()

    left_records = left_df.to_dict(orient="records")
    right_records = right_df.to_dict(orient="records")

    matches: List[Dict[str, object]] = []
    duplicates: List[Dict[str, object]] = []
    not_reporting_fees: List[Dict[str, object]] = []

    seen_pairs = set()
    for record in left_records:
        key = (record["_name_key"], record["_acpc_key"])
        if key in seen_pairs:
            duplicates.append({"name": record["Name"], "acpc": record["ACPC Application Number"], "fees": record["Fees"]})
            continue
        seen_pairs.add(key)

        matching_right = [r for r in right_records if normalize_text(r.get("Name")) == record["_name_key"] and normalize_number(r.get("ACPC Application Number")) == record["_acpc_key"]]
        if matching_right:
            matches.append({"name": record["Name"], "acpc": record["ACPC Application Number"], "fees": record["Fees"]})
        else:
            not_reporting_fees.append({"name": record["Name"], "acpc": record["ACPC Application Number"], "fees": record["Fees"]})

    for record in right_records:
        key = (normalize_text(record.get("Name")), normalize_number(record.get("ACPC Application Number")))
        if key in seen_pairs:
            continue
        not_reporting_fees.append({"name": record.get("Name"), "acpc": record.get("ACPC Application Number"), "fees": record.get("Fees")})

    return {
        "matches": matches,
        "duplicates": duplicates,
        "not_reporting_fees": not_reporting_fees,
    }


def read_excel_bytes(file_bytes: bytes) -> pd.DataFrame:
    return pd.read_excel(BytesIO(file_bytes), engine="openpyxl")


def build_report(left_df: pd.DataFrame, right_df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    result = process_datasets(left_df, right_df)
    matches_df = pd.DataFrame(result["matches"])
    duplicates_df = pd.DataFrame(result["duplicates"])
    fees_df = pd.DataFrame(result["not_reporting_fees"])
    return matches_df, duplicates_df, fees_df
