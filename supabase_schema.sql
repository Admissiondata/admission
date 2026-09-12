CREATE TABLE IF NOT EXISTS registrations (
  no text PRIMARY KEY,
  date text NOT NULL,
  name text NOT NULL,
  gender text NOT NULL,
  dob text NOT NULL,
  age integer NOT NULL,
  mobile text NOT NULL,
  k_sar text,
  k_gam text,
  k_tal text,
  k_pin text,
  h_sar text,
  h_gam text,
  h_tal text,
  h_pin text,
  fee integer NOT NULL,
  ts bigint NOT NULL,
  photo text,
  aadhar text,
  aadhar_no text,
  role text NOT NULL DEFAULT 'operator',
  status text NOT NULL DEFAULT 'pending',
  approved_by text,
  qr_code text
);

CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_registrations_role ON registrations(role);
