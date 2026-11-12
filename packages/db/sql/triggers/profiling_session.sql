CREATE OR REPLACE TRIGGER profiling_session_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.profiling_session FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
