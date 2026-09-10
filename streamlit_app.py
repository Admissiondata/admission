from io import BytesIO

import pandas as pd
import streamlit as st

from app import build_report, read_excel_bytes

st.set_page_config(page_title="Admission Match Tool", layout="wide")

st.title("Excel Upload and Matching Tool")
st.write("Upload two Excel sheets to match by name and ACPC application number, detect duplicates, and list records not reporting fees.")

left_file = st.file_uploader("Upload first Excel sheet", type=["xlsx", "xls"])
right_file = st.file_uploader("Upload second Excel sheet", type=["xlsx", "xls"])

if left_file and right_file:
    left_df = read_excel_bytes(left_file.getvalue())
    right_df = read_excel_bytes(right_file.getvalue())

    if {"Name", "ACPC Application Number", "Fees"}.issubset(left_df.columns) and {"Name", "ACPC Application Number", "Fees"}.issubset(right_df.columns):
        matches_df, duplicates_df, fees_df = build_report(left_df, right_df)

        st.subheader("Matches")
        st.dataframe(matches_df, use_container_width=True)

        st.subheader("Duplicates")
        st.dataframe(duplicates_df, use_container_width=True)

        st.subheader("Not Reporting Fees")
        st.dataframe(fees_df, use_container_width=True)

        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            matches_df.to_excel(writer, sheet_name="Matches", index=False)
            duplicates_df.to_excel(writer, sheet_name="Duplicates", index=False)
            fees_df.to_excel(writer, sheet_name="Not Reporting Fees", index=False)

        output.seek(0)
        st.download_button(
            label="Download matched report as Excel",
            data=output.getvalue(),
            file_name="admission_report.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    else:
        st.error("Both sheets must contain Name, ACPC Application Number, and Fees columns.")
