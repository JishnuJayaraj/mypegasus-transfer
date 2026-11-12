CREATE OR REPLACE TRIGGER dsv_offer_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.dsv_offer FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
