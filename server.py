import csv
import io
import json
import os
import re
import sqlite3
import threading
from datetime import date
from pathlib import Path
from io import BytesIO

from flask import Flask, jsonify, request, send_from_directory, Response

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "navratri"
DB_PATH = BASE_DIR / "navratri_data.db"

DEFAULT_PIN = "1234"
ADMIN_PIN = os.environ.get("ADMIN_PIN", DEFAULT_PIN)

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()

GENDER_FEE = {"bahin": 50, "bhai": 100}
MOBILE_RE = re.compile(r"^\d{10}$")
AADHAR_RE = re.compile(r"^\d{12}$")

DEFAULT_SETTINGS = {
    "title": "ગરબા પાસ – નવરાત્રી મહોત્સવ ૨૦૨૬",
    "subtitle": "શ્રી ખેલૈયા મંડળ, વાસદ",
    "address": "",
    "date_from": "11-10-2026",
    "date_to": "20-11-2026",
}


# ------------------------- database -------------------------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS registrations (
                no        TEXT PRIMARY KEY,
                date      TEXT NOT NULL,
                name      TEXT NOT NULL,
                gender    TEXT NOT NULL,
                dob       TEXT NOT NULL,
                age       INTEGER NOT NULL,
                mobile    TEXT NOT NULL,
                k_sar     TEXT, k_gam TEXT, k_tal TEXT, k_pin TEXT,
                h_sar     TEXT, h_gam TEXT, h_tal TEXT, h_pin TEXT,
                fee       INTEGER NOT NULL,
                ts        INTEGER NOT NULL,
                photo     TEXT, aadhar TEXT, aadhar_no TEXT
            )"""
        )
        cols = {r["name"] for r in c.execute("PRAGMA table_info(registrations)").fetchall()}
        for col, ddl in (("photo", "TEXT"), ("aadhar", "TEXT"), ("aadhar_no", "TEXT")):
            if col not in cols:
                c.execute(f"ALTER TABLE registrations ADD COLUMN {col} {ddl}")
        c.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        c.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('counter', '0')")


def get_counter():
    with db() as c:
        row = c.execute("SELECT value FROM meta WHERE key='counter'").fetchone()
    return int(row["value"])


def set_counter(n):
    with db() as c:
        c.execute("UPDATE meta SET value=? WHERE key='counter'", (str(n),))


def next_no():
    with _lock:
        n = get_counter() + 1
        set_counter(n)
        return f"NP-{date.today().year}-{n:04d}", n


def calc_age(dob_str: str):
    try:
        d = date.fromisoformat(dob_str)
    except (ValueError, TypeError):
        return None
    today = date.today()
    age = today.year - d.year - ((today.month, today.day) < (d.month, d.day))
    return age


def row_to_dict(r, with_blobs=False):
    d = {
        "no": r["no"],
        "date": r["date"],
        "name": r["name"],
        "gender": r["gender"],
        "dob": r["dob"],
        "age": r["age"],
        "mobile": r["mobile"],
        "k": [r["k_sar"], r["k_gam"], r["k_tal"], r["k_pin"]],
        "h": [r["h_sar"], r["h_gam"], r["h_tal"], r["h_pin"]],
        "fee": r["fee"],
        "ts": r["ts"],
        "aadhar_no": r["aadhar_no"] or "",
        "has_photo": bool(r["photo"]),
        "has_aadhar": bool(r["aadhar"]),
    }
    if with_blobs:
        d["photo"] = r["photo"] or ""
        d["aadhar"] = r["aadhar"] or ""
    return d


# ------------------------- settings -------------------------
def get_settings():
    with db() as c:
        row = c.execute("SELECT value FROM meta WHERE key='settings'").fetchone()
    if not row:
        return dict(DEFAULT_SETTINGS)
    try:
        s = json.loads(row["value"])
        return {**DEFAULT_SETTINGS, **s}
    except (ValueError, TypeError):
        return dict(DEFAULT_SETTINGS)


def set_settings(s):
    with db() as c:
        c.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)",
            (json.dumps(s, ensure_ascii=False),),
        )


def logo_url():
    return "/logo.png" if (BASE_DIR / "navratri" / "logo.png").exists() else ""


# ------------------------- admin pin -------------------------
def check_pin():
    if ADMIN_PIN is None or ADMIN_PIN == "":
        return True
    return request.headers.get("X-Admin-Pin", "").strip() == ADMIN_PIN


def pin_error():
    return jsonify({"ok": False, "error": "એડમિન PIN ખોટો છે."}), 401


# ------------------------- routes -------------------------
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "name": "Navratri Garba Pass 2026"})


@app.get("/api/next")
def api_next():
    return jsonify({"no": f"NP-{date.today().year}-{get_counter() + 1:04d}"})


@app.post("/api/register")
def api_register():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    gender = str(data.get("gender", "")).strip()
    dob = str(data.get("dob", "")).strip()
    mobile = str(data.get("mobile", "")).strip()

    if not name:
        return jsonify({"ok": False, "error": "નામ ફરજિયાત છે."}), 400
    if gender not in GENDER_FEE:
        return jsonify({"ok": False, "error": "લિંગ પસંદ કરો (બહેન / ભાઈ)."}), 400
    if not MOBILE_RE.match(mobile):
        return jsonify({"ok": False, "error": "મોબાઈલ નંબર ૧૦ આંકડાનો ફરજિયાત છે."}), 400
    age = calc_age(dob)
    if age is None or age < 0:
        return jsonify({"ok": False, "error": "જન્મ તારીખ સાચી નથી."}), 400

    addr = data.get("k") or []
    haddr = data.get("h") or []
    k = [str(addr[i]).strip() if i < len(addr) else "" for i in range(4)]
    h = [str(haddr[i]).strip() if i < len(haddr) else "" for i in range(4)]

    aadhar_no = str(data.get("aadhar_no", "")).strip()
    if aadhar_no and not AADHAR_RE.match(aadhar_no):
        return jsonify({"ok": False, "error": "આધાર નંબર ૧૨ આંકડાનો ફરજિયાત છે."}), 400
    photo = str(data.get("photo") or "").strip()
    aadhar = str(data.get("aadhar") or "").strip()

    rec_no, _ = next_no()
    ts = int(__import__("time").time() * 1000)
    with db() as c:
        c.execute(
            """INSERT INTO registrations
               (no, date, name, gender, dob, age, mobile,
                k_sar, k_gam, k_tal, k_pin, h_sar, h_gam, h_tal, h_pin, fee, ts,
                photo, aadhar, aadhar_no)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rec_no, date.today().isoformat(), name, gender, dob, age, mobile,
             k[0], k[1], k[2], k[3], h[0], h[1], h[2], h[3], GENDER_FEE[gender], ts,
             photo, aadhar, aadhar_no),
        )

    with db() as c:
        row = c.execute("SELECT * FROM registrations WHERE no=?", (rec_no,)).fetchone()
    return jsonify({"ok": True, "no": rec_no, "record": row_to_dict(row, with_blobs=True)})


@app.get("/api/registrations")
def api_list():
    q = request.args.get("q", "").strip().lower()
    with db() as c:
        if q:
            like = f"%{q}%"
            rows = c.execute(
                """SELECT * FROM registrations
                   WHERE lower(name) LIKE ? OR mobile LIKE ? OR lower(no) LIKE ?
                   ORDER BY ts DESC""",
                (like, like, like),
            ).fetchall()
        else:
            rows = c.execute("SELECT * FROM registrations ORDER BY ts DESC").fetchall()
    items = []
    for r in rows:
        d = row_to_dict(r)
        d["photo"] = r["photo"] or ""
        items.append(d)
    return jsonify(items)


@app.get("/api/registrations/<no>")
def api_get(no):
    with db() as c:
        row = c.execute("SELECT * FROM registrations WHERE no=?", (no,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "પાસ મળ્યો નથી."}), 404
    return jsonify(row_to_dict(row, with_blobs=True))


@app.patch("/api/registrations/<no>")
def api_patch(no):
    if not check_pin():
        return pin_error()
    row = None
    with db() as c:
        row = c.execute("SELECT * FROM registrations WHERE no=?", (no,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "પાસ મળ્યો નથી."}), 404

    data = request.get_json(silent=True) or {}

    def field(name):
        return str(data.get(name, row[name] or "")).strip()

    name = field("name")
    mobile = field("mobile")
    dob = field("dob")
    rdate = field("date")
    if not name:
        return jsonify({"ok": False, "error": "નામ ફરજિયાત છે."}), 400
    if not mobile or not MOBILE_RE.match(mobile):
        return jsonify({"ok": False, "error": "મોબાઈલ નંબર ૧૦ આંકડાનો ફરજિયાત છે."}), 400
    age = calc_age(dob)
    if age is None or age < 0:
        return jsonify({"ok": False, "error": "જન્મ તારીખ સાચી નથી."}), 400

    aadhar_no = field("aadhar_no")
    if aadhar_no and not AADHAR_RE.match(aadhar_no):
        return jsonify({"ok": False, "error": "આધાર નંબર ૧૨ આંકડાનો ફરજિયાત છે."}), 400

    def addr(arr, cur):
        out = []
        for i in range(4):
            out.append(str(arr[i]).strip() if i < len(arr) else (cur[i] or ""))
        return out

    k = addr(data.get("k") or [], [row["k_sar"], row["k_gam"], row["k_tal"], row["k_pin"]])
    h = addr(data.get("h") or [], [row["h_sar"], row["h_gam"], row["h_tal"], row["h_pin"]])

    photo = data.get("photo")
    if photo is None:
        photo = row["photo"]
    aadhar = data.get("aadhar")
    if aadhar is None:
        aadhar = row["aadhar"]

    with db() as c:
        c.execute(
            """UPDATE registrations SET date=?, name=?, dob=?, age=?, mobile=?,
               k_sar=?, k_gam=?, k_tal=?, k_pin=?, h_sar=?, h_gam=?, h_tal=?, h_pin=?,
               photo=?, aadhar=?, aadhar_no=?
               WHERE no=?""",
            (rdate, name, dob, age, mobile,
             k[0], k[1], k[2], k[3], h[0], h[1], h[2], h[3],
             photo, aadhar, aadhar_no, no),
        )
    with db() as c:
        row = c.execute("SELECT * FROM registrations WHERE no=?", (no,)).fetchone()
    return jsonify({"ok": True, "record": row_to_dict(row, with_blobs=True)})


@app.delete("/api/registrations/<no>")
def api_delete(no):
    if not check_pin():
        return pin_error()
    with db() as c:
        cur = c.execute("DELETE FROM registrations WHERE no=?", (no,))
    if cur.rowcount == 0:
        return jsonify({"ok": False, "error": "રજીસ્ટ્રેશન મળ્યું નથી."}), 404
    return jsonify({"ok": True})


@app.post("/api/clear")
def api_clear():
    if not check_pin():
        return pin_error()
    with _lock:
        with db() as c:
            c.execute("DELETE FROM registrations")
        set_counter(0)
    return jsonify({"ok": True})


@app.get("/api/settings")
def api_get_settings():
    s = get_settings()
    s["logo"] = logo_url()
    return jsonify(s)


@app.post("/api/settings")
def api_save_settings():
    if not check_pin():
        return pin_error()
    data = request.get_json(silent=True) or {}
    s = get_settings()
    for key in ("title", "subtitle", "address", "date_from", "date_to"):
        if key in data:
            s[key] = str(data[key]).strip()
    set_settings(s)
    s["logo"] = logo_url()
    return jsonify({"ok": True, "settings": s})


@app.post("/api/logo")
def api_logo():
    if not check_pin():
        return pin_error()
    f = request.files.get("logo")
    if f is None:
        return jsonify({"ok": False, "error": "લોગો ફાઈલ પસંદ કરો."}), 400
    data = f.read()
    if not data:
        return jsonify({"ok": False, "error": "ખાલી ફાઈલ છે."}), 400
    if len(data) > 5 * 1024 * 1024:
        return jsonify({"ok": False, "error": "લોગો ફાઈલ ૫ MB થી નાની રાખો."}), 400
    (STATIC_DIR / "logo.png").write_bytes(data)
    return jsonify({"ok": True, "logo": "/logo.png"})


@app.get("/api/stats")
def api_stats():
    with db() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM registrations").fetchone()["n"]
        b = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0) AS f FROM registrations WHERE gender='bahin'").fetchone()
        o = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0) AS f FROM registrations WHERE gender='bhai'").fetchone()
    return jsonify({
        "total": total,
        "bahin": b["n"], "bahin_fee": b["f"],
        "bhai": o["n"], "bhai_fee": o["f"],
        "total_fee": b["f"] + o["f"],
    })


@app.get("/api/export.csv")
def api_export_csv():
    with db() as c:
        rows = c.execute("SELECT * FROM registrations ORDER BY ts DESC").fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["નો", "તારીખ", "નામ", "લિંગ", "જન્મ તારીખ", "ઉમર", "મોબાઈલ",
                "કાયમી સરનામું", "ગામ", "તાલુકો", "પિન",
                "હાલ સરનામું", "ગામ", "તાલુકો", "પિન", "આધાર નંબર", "ફી"])
    for r in rows:
        w.writerow([r["no"], r["date"], r["name"], r["gender"], r["dob"], r["age"], r["mobile"],
                    r["k_sar"], r["k_gam"], r["k_tal"], r["k_pin"],
                    r["h_sar"], r["h_gam"], r["h_tal"], r["h_pin"],
                    r["aadhar_no"] or "", r["fee"]])
    data = "\ufeff" + buf.getvalue()
    return Response(
        data,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=navratri_registrations.csv"},
    )


@app.get("/api/export.xlsx")
def api_export_xlsx():
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    with db() as c:
        rows = c.execute("SELECT * FROM registrations ORDER BY ts DESC").fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = "Registrations"
    headers = ["નો.", "તારીખ", "નામ", "લિંગ", "જન્મ તારીખ", "ઉમર", "મોબાઈલ",
               "કાયમી સરનામું", "ગામ", "તાલુકો", "પિન",
               "હાલ સરનામું", "ગામ", "તાલુકો", "પિન", "આધાર નંબર", "ફી"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="8E1B2E")
        cell.alignment = Alignment(horizontal="center")

    gender_label = {"bahin": "બહેન", "bhai": "ભાઈ"}
    for r in rows:
        ws.append([r["no"], r["date"], r["name"], gender_label.get(r["gender"], r["gender"]),
                   r["dob"], r["age"], r["mobile"],
                   r["k_sar"], r["k_gam"], r["k_tal"], r["k_pin"],
                   r["h_sar"], r["h_gam"], r["h_tal"], r["h_pin"],
                   r["aadhar_no"] or "", r["fee"]])

    widths = [14, 12, 28, 8, 12, 6, 12, 24, 14, 14, 8, 24, 14, 14, 8, 16, 8]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=navratri_registrations.xlsx"},
    )


@app.get("/api/export.json")
def api_export_json():
    pin_ok = check_pin()
    if not pin_ok:
        return pin_error()
    with db() as c:
        rows = c.execute("SELECT * FROM registrations ORDER BY ts DESC").fetchall()
    payload = json.dumps({"counter": get_counter(), "ledger": [row_to_dict(r, with_blobs=True) for r in rows]},
                         ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=navratri_backup.json"},
    )


@app.post("/api/import")
def api_import():
    if not check_pin():
        return pin_error()
    data = request.get_json(silent=True) or {}
    ledger = data.get("ledger")
    if not isinstance(ledger, list):
        return jsonify({"ok": False, "error": "બેકઅપ ફાઈલ સાચી નથી."}), 400

    records = []
    for item in ledger:
        if not isinstance(item, dict) or not item.get("no") or not item.get("name"):
            continue
        age = item.get("age")
        if age is None:
            age = calc_age(str(item.get("dob", "")))
            if age is None:
                continue
        k = item.get("k") or [None] * 4
        h = item.get("h") or [None] * 4
        records.append((
            item.get("no"), item.get("date", date.today().isoformat()),
            item.get("name"), item.get("gender", "bhai"), item.get("dob", ""),
            age, item.get("mobile", ""),
            k[0] if k and len(k) > 0 else None,
            k[1] if k and len(k) > 1 else None,
            k[2] if k and len(k) > 2 else None,
            k[3] if k and len(k) > 3 else None,
            h[0] if h and len(h) > 0 else None,
            h[1] if h and len(h) > 1 else None,
            h[2] if h and len(h) > 2 else None,
            h[3] if h and len(h) > 3 else None,
            item.get("fee", 50), item.get("ts", 0) or 0,
            item.get("photo") or "", item.get("aadhar") or "",
            item.get("aadhar_no") or "",
        ))

    if not records:
        return jsonify({"ok": False, "error": "બેકઅપ ફાઈલમાં કોઈ લાયક રેકોર્ડ નથી."}), 400

    with _lock:
        with db() as c:
            c.execute("DELETE FROM registrations")
            c.executemany(
                """INSERT OR REPLACE INTO registrations
                   (no, date, name, gender, dob, age, mobile,
                    k_sar, k_gam, k_tal, k_pin, h_sar, h_gam, h_tal, h_pin, fee, ts,
                    photo, aadhar, aadhar_no)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                records,
            )
        nums = [int(r[0].rsplit("-", 1)[-1]) for r in records if r[0] and r[0].rsplit("-", 1)[-1].isdigit()]
        max_no = max(nums) if nums else 0
        given = int(str(data.get("counter", "0")))
        set_counter(max(max_no, given))

    return jsonify({"ok": True, "count": len(records)})


if __name__ == "__main__":
    init_db()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    print(f"Navratri Garba Pass server -> http://{host}:{port}")
    app.run(host=host, port=port, debug=False)