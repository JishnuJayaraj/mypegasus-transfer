CREATE OR REPLACE TRIGGER assisted_mode_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.assisted_mode FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
