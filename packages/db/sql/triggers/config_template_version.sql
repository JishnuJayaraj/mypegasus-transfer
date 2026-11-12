CREATE OR REPLACE TRIGGER config_template_version_append_only BEFORE DELETE OR UPDATE ON public.config_template_version FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
