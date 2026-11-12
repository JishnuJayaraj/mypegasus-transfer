CREATE OR REPLACE TRIGGER config_relaxation_request_progresses BEFORE UPDATE ON public.config_relaxation_request FOR EACH ROW EXECUTE FUNCTION public.config_relaxation_request_progresses();
