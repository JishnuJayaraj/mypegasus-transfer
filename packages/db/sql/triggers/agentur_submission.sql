CREATE OR REPLACE TRIGGER agentur_submission_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.agentur_submission FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
