CREATE OR REPLACE TRIGGER participation_dsv_amendment_append_only BEFORE DELETE OR UPDATE ON public.participation_dsv_amendment FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
