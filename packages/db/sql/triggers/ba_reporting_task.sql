CREATE OR REPLACE TRIGGER ba_reporting_task_progresses BEFORE DELETE OR UPDATE ON public.ba_reporting_task FOR EACH ROW EXECUTE FUNCTION public.ba_reporting_task_progresses();
