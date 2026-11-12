CREATE OR REPLACE TRIGGER signed_declaration_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.signed_declaration FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
