CREATE OR REPLACE TRIGGER document_link_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.document_link FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
