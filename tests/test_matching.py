import pandas as pd

from app import process_datasets


def test_process_datasets_identifies_matches_duplicates_and_fee_gaps():
    left = pd.DataFrame(
        [
            {"Name": "John Doe", "ACPC Application Number": "1001", "Fees": "5000"},
            {"Name": "John Doe", "ACPC Application Number": "1001", "Fees": "5000"},
            {"Name": "Jane Smith", "ACPC Application Number": "1002", "Fees": ""},
        ]
    )
    right = pd.DataFrame(
        [
            {"Name": "John Doe", "ACPC Application Number": "1001", "Fees": "5000"},
            {"Name": "Alice Brown", "ACPC Application Number": "1003", "Fees": "0"},
        ]
    )

    result = process_datasets(left, right)

    assert len(result["matches"]) == 1
    assert result["matches"][0]["name"] == "John Doe"
    assert result["matches"][0]["acpc"] == "1001"

    assert len(result["duplicates"]) == 1
    assert result["duplicates"][0]["name"] == "John Doe"

    assert len(result["not_reporting_fees"]) == 2
    assert {item["name"] for item in result["not_reporting_fees"]} == {"Jane Smith", "Alice Brown"}
