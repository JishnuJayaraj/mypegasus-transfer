CREATE OR REPLACE TRIGGER dsv_scan_signature_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.dsv_scan_signature FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
