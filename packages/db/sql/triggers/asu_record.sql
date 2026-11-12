CREATE OR REPLACE TRIGGER asu_record_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.asu_record FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
