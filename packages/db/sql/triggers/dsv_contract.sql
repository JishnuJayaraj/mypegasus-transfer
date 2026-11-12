CREATE OR REPLACE TRIGGER dsv_contract_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.dsv_contract FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
