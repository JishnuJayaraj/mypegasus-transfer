CREATE OR REPLACE TRIGGER appointment_booking_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.appointment_booking FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
