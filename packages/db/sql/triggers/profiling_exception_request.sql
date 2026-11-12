CREATE OR REPLACE TRIGGER profiling_exception_request_progresses BEFORE UPDATE ON public.profiling_exception_request FOR EACH ROW EXECUTE FUNCTION public.profiling_exception_request_progresses();
