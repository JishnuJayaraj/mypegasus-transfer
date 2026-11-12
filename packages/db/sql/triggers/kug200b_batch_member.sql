CREATE OR REPLACE TRIGGER kug200b_batch_member_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.kug200b_batch_member FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
