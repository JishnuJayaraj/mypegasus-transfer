CREATE OR REPLACE TRIGGER activation_code_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.activation_code FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
