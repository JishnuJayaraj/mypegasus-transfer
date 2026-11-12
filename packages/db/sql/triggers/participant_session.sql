CREATE OR REPLACE TRIGGER participant_session_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.participant_session FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
