CREATE OR REPLACE TRIGGER ba_reporting_task_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.ba_reporting_task FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
CREATE OR REPLACE TRIGGER ba_reporting_task_progresses BEFORE DELETE OR UPDATE ON public.ba_reporting_task FOR EACH ROW EXECUTE FUNCTION public.ba_reporting_task_progresses();
