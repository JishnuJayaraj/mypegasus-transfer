CREATE OR REPLACE TRIGGER privacy_notice_delivery_immutable BEFORE DELETE OR UPDATE ON public.privacy_notice_delivery FOR EACH ROW EXECUTE FUNCTION public.keep_privacy_notice_immutable();
