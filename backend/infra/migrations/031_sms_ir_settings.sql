CREATE TABLE IF NOT EXISTS sms_ir_settings (
    singleton boolean PRIMARY KEY CHECK (singleton),
    api_key_encrypted text NOT NULL,
    line_number text NOT NULL CHECK (line_number ~ '^[1-9][0-9]{0,15}$'),
    enabled boolean NOT NULL DEFAULT false
);
