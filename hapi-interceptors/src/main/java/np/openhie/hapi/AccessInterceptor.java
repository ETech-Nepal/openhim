package np.openhie.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.IBundleProvider;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.param.TokenParam;
import ca.uhn.fhir.rest.server.exceptions.AuthenticationException;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import ca.uhn.fhir.rest.server.exceptions.ResourceNotFoundException;
import ca.uhn.fhir.rest.server.exceptions.UnprocessableEntityException;
import ca.uhn.fhir.util.FhirTerser;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.hl7.fhir.instance.model.api.IBaseReference;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.instance.model.api.IIdType;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Coding;
import org.hl7.fhir.r4.model.Encounter;
import org.hl7.fhir.r4.model.IdType;
import org.hl7.fhir.r4.model.Identifier;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.Reference;
import org.hl7.fhir.r4.model.Resource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Access rules for the national FHIR store. Every request names its client with a verified
 * Keycloak token, and the rules apply the same whichever OpenHIM route or mediator the request
 * came through:
 *
 * <ul>
 *   <li>SMART v2 system scopes per request and per stored resource (transaction entries too);
 *   <li>Patient writes only from the identity mediator;
 *   <li>a facility writes as itself: its source-facility tag and Organization are stamped on
 *       create, and only the owning facility may update a record;
 *   <li>searches are scoped to one named patient;
 *   <li>references to a retired (merged) Patient are redirected to the survivor.
 * </ul>
 *
 * Loaded by hapi.fhir.custom-bean-packages (np.openhie.hapi) and
 * hapi.fhir.custom-interceptor-classes (np.openhie.hapi.AccessInterceptor).
 */
@Component
@Interceptor
public class AccessInterceptor {
  private static final Logger log = LoggerFactory.getLogger(AccessInterceptor.class);
  private static final String CALLER = AccessInterceptor.class.getName() + ".caller";
  // Operations with no patient data, for any authenticated client.
  private static final Pattern NHFR_NAMESPACE = Pattern.compile(Pattern.quote(Rules.NHFR) + "/[^|&\\s]+");
  private static final Set<String> TERMINOLOGY_OPS = Set.of("$expand", "$validate-code", "$lookup", "$translate", "$subsumes");

  private final DaoRegistry daos;
  private final FhirTerser terser;
  private final TokenVerifier tokens;
  private final String identityClient;
  private final Set<String> phoneLookupClients;
  private final Map<String, CachedRef> orgs = new ConcurrentHashMap<>();

  private record CachedRef(String reference, long at) {}

  public AccessInterceptor(DaoRegistry daos, FhirContext fhirContext) {
    this.daos = daos;
    this.terser = fhirContext.newTerser();
    String issuer = required("NP_AUTH_ISSUER");
    this.tokens = new TokenVerifier(issuer, required("NP_AUTH_JWKS_URI"));
    this.identityClient = System.getenv().getOrDefault("NP_IDENTITY_CLIENT_ID", "identity-mediator");
    // Clients allowed to find a Patient by phone (the patient portal's OTP login).
    this.phoneLookupClients = Set.of(System.getenv().getOrDefault("NP_PHONE_LOOKUP_CLIENT_IDS", "").split("\\s*,\\s*"));
    log.info("NP access rules active: issuer {}, Patient writes only from {}", issuer, identityClient);
  }

  // ─── Every request ────────────────────────────────────────────────────────

  // Runs before request validation, so an unauthenticated request learns nothing about
  // its body.
  @Hook(value = Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED, order = -100)
  public boolean authenticate(RequestDetails request) {
    if ("metadata".equals(request.getRequestPath())) return true;
    TokenVerifier.Caller caller = tokens.verify(request.getHeader("Authorization"));
    if (caller == null) throw new AuthenticationException("A valid access token is required");
    request.getUserData().put(CALLER, caller);
    byte[] body = request.loadRequestContents();
    if (body != null && body.length > 0 && Rules.unencodedPathlessSystem(new String(body, StandardCharsets.UTF_8))) {
      throw new InvalidRequestException(
          "URL-encode the identifier in a conditional reference, e.g. "
              + "Patient?identifier=http%3A%2F%2Fdonidcr.gov.np%7C<value>");
    }
    return true;
  }

  @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
  public void incoming(RequestDetails request, RestOperationTypeEnum op) {
    if (op == RestOperationTypeEnum.METADATA) return;
    TokenVerifier.Caller caller = caller(request);
    if (caller == null) throw new AuthenticationException("A valid access token is required");

    String type = request.getResourceName();
    switch (op) {
      case READ, VREAD, HISTORY_INSTANCE -> need(caller, type, 'r');
      case SEARCH_TYPE -> {
        need(caller, type, 's');
        String refused = Rules.refuseSearch(type, request.getParameters(), phoneLookupClients.contains(caller.clientId()));
        if (refused != null) throw new InvalidRequestException(refused);
      }
      case GET_PAGE -> {} // a page of a search that was already allowed
      case CREATE -> writeRequest(caller, type, 'c', request);
      case UPDATE, PATCH -> writeRequest(caller, type, 'u', request);
      case DELETE -> need(caller, type, 'd');
      case TRANSACTION, BATCH -> bundleRequest(caller, request);
      case EXTENDED_OPERATION_TYPE, EXTENDED_OPERATION_INSTANCE, EXTENDED_OPERATION_SERVER -> {
        String name = request.getOperation();
        if ("$validate".equals(name) && type != null) need(caller, type, 'c');
        else if (!TERMINOLOGY_OPS.contains(name)) throw new ForbiddenOperationException("Operation " + name + " is not allowed");
      }
      default -> throw new ForbiddenOperationException("Operation " + op + " is not allowed");
    }
  }

  private void writeRequest(TokenVerifier.Caller caller, String type, char action, RequestDetails request) {
    need(caller, type, action);
    patientWriter(caller, type);
    bareMrnReferences(request.getResource());
    if (request.getResource() != null) foreignNamespaces(request.getResource(), caller);
    foreignNamespaceUrl(request.getCompleteUrl(), caller);
  }

  // Entries are also checked one by one as they are stored; this rejects a bundle early,
  // before any entry runs, for what can be seen in the request itself.
  private void bundleRequest(TokenVerifier.Caller caller, RequestDetails request) {
    if (!(request.getResource() instanceof Bundle bundle)) return;
    for (Bundle.BundleEntryComponent entry : bundle.getEntry()) {
      Bundle.HTTPVerb verb = entry.getRequest().getMethod();
      String url = entry.getRequest().getUrl();
      String type = entry.hasResource() ? entry.getResource().fhirType() : url == null ? null : url.split("[/?]")[0];
      if (type == null || verb == null) continue;
      switch (verb) {
        case GET, HEAD -> need(caller, type, url != null && url.contains("?") ? 's' : 'r');
        case POST -> need(caller, type, 'c');
        case PUT, PATCH -> need(caller, type, 'u');
        case DELETE -> need(caller, type, 'd');
        default -> {}
      }
      if (verb != Bundle.HTTPVerb.GET && verb != Bundle.HTTPVerb.HEAD) patientWriter(caller, type);
      String ifNoneExist = entry.getRequest().getIfNoneExist();
      if (Rules.usesBareMrn(url) || Rules.usesBareMrn(ifNoneExist)) bareMrn();
      // A conditional create on another facility's namespace would answer 200 with that
      // facility's record and silently drop this one.
      foreignNamespaceUrl(url, caller);
      foreignNamespaceUrl(ifNoneExist, caller);
      if (entry.hasResource()) {
        bareMrnReferences(entry.getResource());
        foreignNamespaces(entry.getResource(), caller);
      }
    }
  }

  // ─── Every stored resource (single writes and transaction entries alike) ─────────

  @Hook(Pointcut.STORAGE_PRESTORAGE_RESOURCE_CREATED)
  public void created(IBaseResource resource, RequestDetails request) {
    TokenVerifier.Caller caller = caller(request);
    if (caller == null) return; // the server's own work (package install, reindex)
    String type = resource.fhirType();
    need(caller, type, 'c');
    patientWriter(caller, type);
    if (type.equals("Patient")) return; // the identity mediator owns every Patient field
    foreignNamespaces(resource, caller);
    redirectRetiredPatients(resource, caller);
    setFacility((Resource) resource, caller.clientId());
    if (resource instanceof Encounter encounter) encounter.setServiceProvider(new Reference(organization(caller.clientId())));
  }

  @Hook(Pointcut.STORAGE_PRESTORAGE_RESOURCE_UPDATED)
  public void updated(IBaseResource previous, IBaseResource resource, RequestDetails request) {
    TokenVerifier.Caller caller = caller(request);
    if (caller == null) return;
    String type = resource.fhirType();
    need(caller, type, 'u');
    patientWriter(caller, type);
    if (type.equals("Patient")) return;
    String owner = facility((Resource) previous);
    boolean identity = caller.clientId().equals(identityClient);
    // The identity mediator moves records between Patients on a merge; nobody else may
    // change another facility's record.
    if (!identity && !caller.clientId().equals(owner)) {
      throw new ForbiddenOperationException(type + "/" + previous.getIdElement().getIdPart()
          + " belongs to " + (owner == null ? "no recorded facility" : owner) + ", not " + caller.clientId());
    }
    foreignNamespaces(resource, caller);
    redirectRetiredPatients(resource, caller);
    if (owner != null) setFacility((Resource) resource, owner); // ownership never changes
    if (!identity && resource instanceof Encounter encounter) {
      encounter.setServiceProvider(new Reference(organization(caller.clientId())));
    }
  }

  @Hook(Pointcut.STORAGE_PRESTORAGE_RESOURCE_DELETED)
  public void deleted(IBaseResource resource, RequestDetails request) {
    TokenVerifier.Caller caller = caller(request);
    if (caller != null) need(caller, resource.fhirType(), 'd');
  }

  // ─── Rules ──────────────────────────────────────────────────────────────

  private static void need(TokenVerifier.Caller caller, String type, char action) {
    if (type == null || !Rules.hasScope(caller.scopes(), type, action)) {
      throw new ForbiddenOperationException(
          "Client " + caller.clientId() + " lacks scope system/" + type + "." + action);
    }
  }

  private void patientWriter(TokenVerifier.Caller caller, String type) {
    if ("Patient".equals(type) && !caller.clientId().equals(identityClient)) {
      throw new ForbiddenOperationException("Patients are registered through POST /fhir/Patient (identity service)");
    }
  }

  private void bareMrnReferences(IBaseResource resource) {
    if (resource == null) return;
    for (IBaseReference ref : terser.getAllPopulatedChildElementsOfType(resource, IBaseReference.class)) {
      if (Rules.usesBareMrn(ref.getReferenceElement().getValue())) bareMrn();
    }
  }

  private static void bareMrn() {
    throw new InvalidRequestException(
        "A Patient reference by MRN must use the facility's MRN system ("
            + Rules.HOSPITAL_MRN + "/<NHFR>) or the Health ID");
  }

  private void foreignNamespaces(IBaseResource resource, TokenVerifier.Caller caller) {
    if (caller.clientId().equals(identityClient)) return;
    for (Identifier id : terser.getValues(resource, resource.fhirType() + ".identifier", Identifier.class)) {
      if (Rules.foreignFacilityNamespace(id.getSystem(), caller.clientId())) {
        throw new ForbiddenOperationException(
            "Identifier namespace " + id.getSystem() + " does not belong to " + caller.clientId());
      }
    }
  }

  private void foreignNamespaceUrl(String url, TokenVerifier.Caller caller) {
    if (url == null || caller.clientId().equals(identityClient)) return;
    Matcher m = NHFR_NAMESPACE.matcher(URLDecoder.decode(url, StandardCharsets.UTF_8));
    while (m.find()) {
      if (Rules.foreignFacilityNamespace(m.group(), caller.clientId())) {
        throw new ForbiddenOperationException("Identifier namespace " + m.group() + " does not belong to " + caller.clientId());
      }
    }
  }

  // A client that still holds a merged-away Patient's id keeps writing to it; send those
  // records to the surviving Patient instead.
  private void redirectRetiredPatients(IBaseResource resource, TokenVerifier.Caller caller) {
    if (caller.clientId().equals(identityClient)) return;
    for (IBaseReference ref : terser.getAllPopulatedChildElementsOfType(resource, IBaseReference.class)) {
      IIdType id = ref.getReferenceElement();
      if (!"Patient".equals(id.getResourceType()) || !id.hasIdPart() || id.getValue().contains("?")) continue;
      Patient patient;
      try {
        patient = (Patient) daos.getResourceDao("Patient").read(new IdType("Patient", id.getIdPart()), new SystemRequestDetails());
      } catch (ResourceNotFoundException e) {
        continue; // HAPI's own referential-integrity check reports it
      }
      if (patient.getActive()) continue;
      patient.getLink().stream()
          .filter(l -> l.getType() == Patient.LinkType.REPLACEDBY && l.getOther().getReferenceElement().hasIdPart())
          .findFirst()
          .ifPresent(l -> ref.setReference("Patient/" + l.getOther().getReferenceElement().getIdPart()));
    }
  }

  private static String facility(Resource resource) {
    Coding tag = resource.getMeta().getTag().stream()
        .filter(t -> Rules.SOURCE_FACILITY.equals(t.getSystem())).findFirst().orElse(null);
    return tag == null ? null : tag.getCode();
  }

  private static void setFacility(Resource resource, String nhfr) {
    resource.getMeta().getTag().removeIf(t -> Rules.SOURCE_FACILITY.equals(t.getSystem()));
    resource.getMeta().addTag(Rules.SOURCE_FACILITY, nhfr, null);
  }

  // The caller's Organization, by NHFR code. Cached for 5 minutes.
  private String organization(String nhfr) {
    CachedRef hit = orgs.get(nhfr);
    if (hit != null && System.currentTimeMillis() - hit.at() < 300_000) return hit.reference();
    SearchParameterMap map = SearchParameterMap.newSynchronous().add("identifier", new TokenParam(Rules.NHFR, nhfr));
    IBundleProvider found = daos.getResourceDao("Organization").search(map, new SystemRequestDetails());
    List<IBaseResource> list = found.getResources(0, 2);
    if (list.size() != 1) {
      throw new UnprocessableEntityException(
          (list.isEmpty() ? "No" : "More than one") + " Organization has NHFR identifier " + nhfr);
    }
    String reference = "Organization/" + list.get(0).getIdElement().getIdPart();
    orgs.put(nhfr, new CachedRef(reference, System.currentTimeMillis()));
    return reference;
  }

  private static TokenVerifier.Caller caller(RequestDetails request) {
    return request == null ? null : (TokenVerifier.Caller) request.getUserData().get(CALLER);
  }

  private static String required(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) throw new IllegalStateException(name + " must be set");
    return value;
  }
}
