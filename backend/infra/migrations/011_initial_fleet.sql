BEGIN;
SELECT pg_advisory_xact_lock(514011);

-- The original single-file app ships with this starter directory. Copy it to
-- PostgreSQL only on a genuinely empty installation; never merge it into a
-- database that already contains fleet or compatibility data.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM machines)
     AND NOT EXISTS (SELECT 1 FROM people)
     AND NOT EXISTS (SELECT 1 FROM machine_models)
     AND NOT EXISTS (SELECT 1 FROM legacy_workspace) THEN
    INSERT INTO people(id,name,role) VALUES
      ('p1','علی محمدی','driver'),
      ('p2','عبدالحمید ترت زاد','driver'),
      ('p3','سعید صدیقی','driver'),
      ('p4','محمود محمدی','driver'),
      ('p5','صلاح الدین شهبازجو','driver'),
      ('p6','محمود فریدی','driver'),
      ('p7','محمد غفوری','driver'),
      ('p8','عبدالکریم موغفاری','supervisor'),
      ('p9','علی شبانی','pm');

    INSERT INTO machine_models(id,name,brand) VALUES
      ('FM','ولوو FM','Volvo'),
      ('BENZ','بنز','Mercedes-Benz'),
      ('ISUZU','ایسوزو','Isuzu'),
      ('ZL30','لودر ZL30','ZL30'),
      ('L90','لودر ولوو L90','Volvo'),
      ('MF285','تراکتور فرگوسن ۲۸۵','Massey Ferguson'),
      ('MF475','تراکتور فرگوسن ۴۷۵','Massey Ferguson');

    INSERT INTO machines(id,code,plate,type,model_id,driver_id,supervisor_id,pm_id,unit,note) VALUES
      ('m1','FM 414','414ع79','ده تن','FM','p1','p8','p9','km',''),
      ('m2','FM 122','122ع57','ده تن','FM','p2','p8','p9','km',''),
      ('m3','BENZ 655','655ع84','ده تن','BENZ','p3','p8','p9','km',''),
      ('m4','BENZ 173','173ع68','ده تن','BENZ','p4','p8','p9','km',''),
      ('m5','ISUZU 598','598ع82','ده تن','ISUZU','p5','p8','p9','km',''),
      ('m6','ISUZU 776','776ع66','ده تن','ISUZU','p6','p8','p9','km',''),
      ('m7','ZL30','','لودر','ZL30',NULL,'p8','p9','hour','راننده ثابت ندارد'),
      ('m8','VOLVO L90','','لودر','L90',NULL,'p8','p9','hour','راننده ثابت ندارد'),
      ('m9','MF285 زرد','','تراکتور','MF285',NULL,'p8','p9','hour','راننده ثابت ندارد'),
      ('m10','MF285 قرمز','','تراکتور','MF285',NULL,'p8','p9','hour','راننده ثابت ندارد'),
      ('m11','MF475 قرمز','','تراکتور','MF475',NULL,'p8','p9','hour','راننده ثابت ندارد');
  END IF;
END $$;

COMMIT;
