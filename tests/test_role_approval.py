import os

from server import app, init_db, sync_supabase_record


os.environ.setdefault("ADMIN_PIN", "1234")


def test_sync_supabase_record_uses_supabase_payload(monkeypatch):
    calls = []

    def fake_request(method, path, payload=None):
        calls.append((method, path, payload))

    monkeypatch.setattr("server.supabase_enabled", lambda: True)
    monkeypatch.setattr("server.supabase_request", fake_request)

    sync_supabase_record({
        "no": "NP-2026-0001",
        "name": "Asha Patel",
        "status": "pending",
        "role": "operator",
    })

    assert calls
    assert calls[0][0] == "POST"
    assert calls[0][1] == "registrations"
    assert calls[0][2]["no"] == "NP-2026-0001"


def test_operator_registration_starts_pending_and_can_be_approved():
    init_db()
    client = app.test_client()

    payload = {
        "name": "Asha Patel",
        "gender": "bahin",
        "dob": "2002-05-10",
        "mobile": "9876543210",
        "role": "operator",
        "k": ["12, Main Road", "Rajkot", "Rajkot", "360001"],
        "h": ["12, Main Road", "Rajkot", "Rajkot", "360001"],
        "aadhar_no": "123456789012",
        "photo": "data:image/jpeg;base64,abc",
    }

    res = client.post("/api/register", json=payload)
    assert res.status_code == 200, res.get_data(as_text=True)
    body = res.get_json()
    record = body["record"]
    assert record["role"] == "operator"
    assert record["status"] == "pending"

    no = body["no"]
    approval = client.patch(
        f"/api/registrations/{no}",
        headers={"X-Admin-Pin": "1234"},
        json={"status": "approved", "approved_by": "authority"},
    )
    assert approval.status_code == 200, approval.get_data(as_text=True)
    approved = approval.get_json()["record"]
    assert approved["status"] == "approved"
    assert approved["approved_by"] == "authority"

    list_res = client.get("/api/registrations")
    assert list_res.status_code == 200
    rows = list_res.get_json()
    assert any(r["no"] == no and r["status"] == "approved" for r in rows)


def test_user_can_be_created_and_logged_in():
    init_db()
    client = app.test_client()

    create_res = client.post(
        "/api/users",
        json={"username": "demo_admin", "password": "secret123", "role": "admin"},
    )
    assert create_res.status_code == 200, create_res.get_data(as_text=True)
    body = create_res.get_json()
    assert body["ok"] is True
    assert body["user"]["username"] == "demo_admin"

    login_res = client.post(
        "/api/login",
        json={"username": "demo_admin", "password": "secret123"},
    )
    assert login_res.status_code == 200, login_res.get_data(as_text=True)
    login_body = login_res.get_json()
    assert login_body["ok"] is True
    assert login_body["user"]["role"] == "admin"


def test_settings_store_background_image():
    init_db()
    client = app.test_client()

    res = client.post(
        "/api/settings",
        headers={"X-Admin-Pin": "1234"},
        json={"title": "Test Pass", "subtitle": "Village", "background": "/background.png"},
    )
    assert res.status_code == 200, res.get_data(as_text=True)
    payload = res.get_json()
    assert payload["settings"]["background"] == "/background.png"
