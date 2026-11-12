CREATE OR REPLACE TRIGGER kug200b_decline_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.kug200b_decline FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
