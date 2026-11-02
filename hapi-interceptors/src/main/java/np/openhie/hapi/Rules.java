package np.openhie.hapi;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The pure decisions, kept free of HAPI types so they can be unit tested. */
final class Rules {
  private Rules() {}

  static final String NHFR = "http://nhfr.digitalhealth.gov.np";
  static final String SOURCE_FACILITY = "http://mohp.gov.np/fhir/NamingSystem/source-facility";
  static final String HOSPITAL_MRN = "http://mohp.gov.np/fhir/NamingSystem/hospital-mrn";

  /** Resource types that belong to one patient: a search must name the patient. */
  static final Set<String> PATIENT_DATA =
      Set.of(
          "Encounter", "Observation", "DocumentReference", "Condition", "Procedure",
          "AllergyIntolerance", "Immunization", "MedicationRequest", "MedicationStatement",
          "MedicationAdministration", "MedicationDispense", "ServiceRequest", "DiagnosticReport",
          "Specimen");

  /** Directory resources: a search must name what it is looking for. */
  static final Set<String> DIRECTORY = Set.of("Organization", "Practitioner", "PractitionerRole");

  private static final Pattern SCOPE = Pattern.compile("^system/([A-Za-z*]+)\\.([a-z*]+)$");
  private static final Pattern V2_PERMS = Pattern.compile("^c?r?u?d?s?$");

  /**
   * SMART App Launch v2 scopes ({@code system/Patient.cru}, {@code system/*.rs}) and the v1
   * forms ({@code system/Patient.write}). Only the {@code system/} context applies: every
   * client is a backend service.
   */
  static boolean hasScope(List<String> scopes, String type, char action) {
    for (String scope : scopes) {
      Matcher m = SCOPE.matcher(scope);
      if (!m.matches() || !(m.group(1).equals(type) || m.group(1).equals("*"))) continue;
      String perms = m.group(2);
      if (perms.equals("*")) return true;
      if (perms.equals("read") && (action == 'r' || action == 's')) return true;
      if (perms.equals("write") && (action == 'c' || action == 'u' || action == 'd')) return true;
      if (V2_PERMS.matcher(perms).matches() && perms.indexOf(action) >= 0) return true;
    }
    return false;
  }

  /**
   * Cross-facility reads are allowed for continuity of care, but only for a named patient.
   * Returns why a search is refused, or null when it is allowed.
   */
  static String refuseSearch(String type, Map<String, String[]> params) {
    return refuseSearch(type, params, false);
  }

  /** {@code phoneLookup}: the caller may also find a Patient by {@code telecom}. */
  static String refuseSearch(String type, Map<String, String[]> params, boolean phoneLookup) {
    for (Map.Entry<String, String[]> p : params.entrySet()) {
      String name = p.getKey();
      if (name.contains(".") || name.contains(":")) {
        return "Chained searches and search modifiers are not supported: " + name;
      }
      if ((name.equals("_include") || name.equals("_revinclude")) && p.getValue() != null) {
        for (String v : p.getValue()) {
          if (v.contains("*")) return "Wildcard " + name + " is not supported";
        }
      }
    }
    if (type.equals("Binary")) return "Binary cannot be searched; read it by id";
    if (type.equals("Patient") && !has(params, "identifier", "_id") && !(phoneLookup && has(params, "telecom"))) {
      return "Search must be scoped to one patient: Patient search needs identifier or _id";
    }
    if (PATIENT_DATA.contains(type) && !has(params, "patient", "subject")) {
      return "Search must be scoped to one patient: " + type + " search needs patient or subject";
    }
    if (DIRECTORY.contains(type) && !has(params, "identifier", "name", "_id")) {
      return type + " search needs identifier, name or _id";
    }
    return null;
  }

  private static boolean has(Map<String, String[]> params, String... names) {
    for (String n : names) {
      String[] v = params.get(n);
      if (v != null && v.length > 0 && !v[0].isBlank()) return true;
    }
    return false;
  }

  /**
   * An NHFR-rooted identifier namespace (http://nhfr.digitalhealth.gov.np/&lt;code&gt;) belongs to
   * that facility only. Returns true when the system names a facility other than the caller.
   */
  static boolean foreignFacilityNamespace(String system, String caller) {
    return system != null
        && system.startsWith(NHFR + "/")
        && !system.equals(NHFR + "/" + caller);
  }

  // "reference": "Patient?identifier=http://host|value": a system URL without a path,
  // not URL-encoded.
  private static final Pattern UNENCODED_PATHLESS_SYSTEM =
      Pattern.compile("\"reference\"\\s*:\\s*\"[A-Za-z]+\\?[^\"]*?=https?://[^/\"|?&]+\\|");

  /**
   * HAPI 8.12's request validator fails with an internal error on a conditional reference
   * whose identifier system is a URL without a path (http://donidcr.gov.np|...) unless the
   * value is URL-encoded. Such a request is refused with a clear message instead.
   */
  static boolean unencodedPathlessSystem(String body) {
    return body != null && UNENCODED_PATHLESS_SYSTEM.matcher(body).find();
  }

  /**
   * MRNs are scoped per facility (hospital-mrn/&lt;NHFR&gt;). A conditional reference on the
   * shared, unscoped system would match MRN 1001 at every hospital, so it is refused.
   */
  static boolean usesBareMrn(String text) {
    if (text == null) return false;
    String t = text.replace("%7C", "|").replace("%7c", "|").replace("%2F", "/").replace("%2f", "/");
    return t.contains(HOSPITAL_MRN + "|");
  }
}
