BEGIN;
UPDATE app_settings SET payload=payload || '{"smsStageAlerts":false}'::jsonb WHERE singleton AND NOT (payload ? 'smsStageAlerts');
COMMIT;
