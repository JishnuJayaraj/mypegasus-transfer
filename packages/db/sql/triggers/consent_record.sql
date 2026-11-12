CREATE OR REPLACE TRIGGER consent_record_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.consent_record FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
