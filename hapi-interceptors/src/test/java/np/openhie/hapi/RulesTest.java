package np.openhie.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RulesTest {
  @Test
  void smartScopes() {
    assertTrue(Rules.hasScope(List.of("system/Patient.cru"), "Patient", 'c'));
    assertFalse(Rules.hasScope(List.of("system/Patient.rs"), "Patient", 'c'));
    assertTrue(Rules.hasScope(List.of("system/*.crus"), "Encounter", 'u'));
    assertFalse(Rules.hasScope(List.of("system/*.crus"), "Encounter", 'd'));
    assertTrue(Rules.hasScope(List.of("system/Observation.write"), "Observation", 'c'));
    assertFalse(Rules.hasScope(List.of("system/Observation.read"), "Observation", 'u'));
    assertFalse(Rules.hasScope(List.of("user/Patient.cruds", "patient/*.cruds"), "Patient", 'r'));
    assertFalse(Rules.hasScope(List.of("system/Patient.rc"), "Patient", 'c'), "v2 letters are ordered");
    assertFalse(Rules.hasScope(List.of(), "Patient", 'r'));
  }

  @Test
  void searchesMustNameOnePatient() {
    assertNull(Rules.refuseSearch("Patient", Map.of("identifier", new String[] {"sys|1"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of("_count", new String[] {"1000"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of()));
    assertNull(Rules.refuseSearch("Encounter", Map.of("patient", new String[] {"Patient/1"})));
    assertNull(Rules.refuseSearch("Observation", Map.of("subject", new String[] {"Patient/1"})));
    assertNotNull(Rules.refuseSearch("Observation", Map.of("code", new String[] {"x"})));
    assertNotNull(Rules.refuseSearch("Binary", Map.of("_id", new String[] {"1"})));
    assertNull(Rules.refuseSearch("Organization", Map.of("identifier", new String[] {"x|1"})));
    assertNotNull(Rules.refuseSearch("Practitioner", Map.of()));
    assertNull(Rules.refuseSearch("ValueSet", Map.of("url", new String[] {"x"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of("telecom", new String[] {"9841000001"})));
    assertNull(Rules.refuseSearch("Patient", Map.of("telecom", new String[] {"9841000001"}), true));
  }

  @Test
  void chainsModifiersAndWildcardIncludesAreRefused() {
    assertNotNull(Rules.refuseSearch("Encounter", Map.of("patient", new String[] {"P/1"}, "subject.name", new String[] {"x"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of("identifier:missing", new String[] {"false"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of("_id", new String[] {"1"}, "_has:Encounter:patient:status", new String[] {"x"})));
    assertNotNull(Rules.refuseSearch("Patient", Map.of("_id", new String[] {"1"}, "_revinclude", new String[] {"*"})));
    assertNull(Rules.refuseSearch("Encounter", Map.of("patient", new String[] {"P/1"}, "_include", new String[] {"Encounter:subject"})));
  }

  @Test
  void facilityNamespaces() {
    assertFalse(Rules.foreignFacilityNamespace("http://nhfr.digitalhealth.gov.np/1001", "1001"));
    assertTrue(Rules.foreignFacilityNamespace("http://nhfr.digitalhealth.gov.np/2002", "1001"));
    assertFalse(Rules.foreignFacilityNamespace("http://nhfr.digitalhealth.gov.np", "1001"));
    assertFalse(Rules.foreignFacilityNamespace("http://example.org/enc", "1001"));
    assertFalse(Rules.foreignFacilityNamespace(null, "1001"));
  }

  @Test
  void bareMrnReferences() {
    assertTrue(Rules.usesBareMrn("Patient?identifier=http://mohp.gov.np/fhir/NamingSystem/hospital-mrn|1001"));
    assertTrue(Rules.usesBareMrn("Patient?identifier=http://mohp.gov.np/fhir/NamingSystem/hospital-mrn%7C1001"));
    assertFalse(Rules.usesBareMrn("Patient?identifier=http://mohp.gov.np/fhir/NamingSystem/hospital-mrn/1001|1001"));
    assertFalse(Rules.usesBareMrn("Patient/abc"));
    assertFalse(Rules.usesBareMrn(null));
    assertEquals(14, Rules.PATIENT_DATA.size());
  }

  @Test
  void unencodedPathlessSystems() {
    assertTrue(Rules.unencodedPathlessSystem("{\"subject\": {\"reference\": \"Patient?identifier=http://donidcr.gov.np|1\"}}"));
    assertFalse(Rules.unencodedPathlessSystem("{\"reference\":\"Patient?identifier=http%3A%2F%2Fdonidcr.gov.np%7C1\"}"));
    assertFalse(Rules.unencodedPathlessSystem("{\"reference\":\"Patient?identifier=http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id|1\"}"));
    assertFalse(Rules.unencodedPathlessSystem("{\"reference\":\"Patient/abc\"}"));
  }
}
