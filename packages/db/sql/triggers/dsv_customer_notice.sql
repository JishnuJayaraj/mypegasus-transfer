CREATE OR REPLACE TRIGGER dsv_customer_notice_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.dsv_customer_notice FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
