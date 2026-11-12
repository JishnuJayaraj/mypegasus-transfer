CREATE OR REPLACE TRIGGER project_template_pin_append_only BEFORE DELETE OR UPDATE ON public.project_template_pin FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
