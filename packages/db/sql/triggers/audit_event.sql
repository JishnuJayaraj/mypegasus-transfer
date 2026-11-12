CREATE OR REPLACE TRIGGER audit_event_append_only BEFORE DELETE OR UPDATE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();
