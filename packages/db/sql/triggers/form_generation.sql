CREATE OR REPLACE TRIGGER form_generation_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.form_generation FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
