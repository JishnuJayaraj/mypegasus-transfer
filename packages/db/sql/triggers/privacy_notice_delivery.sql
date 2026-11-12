CREATE OR REPLACE TRIGGER privacy_notice_delivery_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.privacy_notice_delivery FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
CREATE OR REPLACE TRIGGER privacy_notice_delivery_immutable BEFORE DELETE OR UPDATE ON public.privacy_notice_delivery FOR EACH ROW EXECUTE FUNCTION public.keep_privacy_notice_immutable();
