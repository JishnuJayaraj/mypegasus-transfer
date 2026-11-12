CREATE OR REPLACE TRIGGER asu_registration_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.asu_registration FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
