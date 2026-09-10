#!/usr/bin/env bash
set -euo pipefail
cd /workspaces/admission
python -m pip install --quiet streamlit pandas openpyxl
python -m streamlit run streamlit_app.py --server.headless true --server.address 0.0.0.0 --server.port 8501 > /tmp/admission-streamlit.log 2>&1 &
