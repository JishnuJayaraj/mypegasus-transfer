CREATE OR REPLACE TRIGGER staff_audit_event_append_only BEFORE DELETE OR UPDATE ON public.staff_audit_event FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();
