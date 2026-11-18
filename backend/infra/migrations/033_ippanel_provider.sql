ALTER TABLE sms_ir_settings
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'smsir',
  ADD COLUMN IF NOT EXISTS ippanel_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS ippanel_sender text,
  ADD COLUMN IF NOT EXISTS ippanel_login_pattern_code text,
  ADD COLUMN IF NOT EXISTS ippanel_name_parameter text NOT NULL DEFAULT 'NAME',
  ADD COLUMN IF NOT EXISTS ippanel_code_parameter text NOT NULL DEFAULT 'CODE';

ALTER TABLE sms_ir_settings DROP CONSTRAINT IF EXISTS sms_ir_settings_provider_check;
ALTER TABLE sms_ir_settings ADD CONSTRAINT sms_ir_settings_provider_check CHECK (provider IN ('mock','smsir','ippanel'));
