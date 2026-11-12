CREATE OR REPLACE TRIGGER evidence_correction_append_only BEFORE DELETE OR UPDATE ON public.evidence_correction FOR EACH ROW EXECUTE FUNCTION public.evidence_correction_append_only();
