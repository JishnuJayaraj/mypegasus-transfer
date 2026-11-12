CREATE OR REPLACE TRIGGER project_config_override_append_only BEFORE DELETE OR UPDATE ON public.project_config_override FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
